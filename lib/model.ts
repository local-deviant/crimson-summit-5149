// Token Radar v3 — the model, written from the design brief + snapshot + kit.
//
// One sentence: every protocol is priced as (value if it launches a token)
// x (the chance it launches one), and the farm verdict comes from the net
// dollars of farming it on a $1,000 ticket — and every step is shown.
//
//   value if it launches = TVL x multiple, multiple from a log-log curve
//     ln(mcap) = a + 0.50 x ln(TVL) + category offset (shrunk n/(n+8)),
//     fitted on the 71 traded protocols whose token is a claim on their
//     own TVL; the slope 0.50 is an explicit prior, NOT the OLS slope
//     (the OLS slope is 0.26 on these comps and 0.21-0.68 across every
//     defensible comp rule, so the data cannot pin it down — see the
//     ablation table in the dashboard). Multiple clamped to [0.08, 1.20].
//     A 7-day growth factor (1 + clamp(change_7d, -60, 120)/100 x 0.3)
//     is applied after the curve.
//   launch odds = [P(ever) - P(ever) x F(a)] / [1 - P(ever) x F(a)],
//     a hazard/survival model: P(ever) per category (age-corrected, shrunk,
//     capped at 0.85) and F(a) the launch-time CDF, a Weibull fitted by
//     maximum likelihood on the snapshot's current-status data
//     (has-token / no-token at each protocol's age).
//   implied value = value if it launches x odds.
//   net on a $1,000 ticket at a 7% drop share =
//     (1000 / TVL) x implied x 0.07 - gas (5 transactions at the chain's
//     rate). FARM when net beats $10, THIN when it beats $0, else SKIP.
//
// No protocol name is ever special-cased: the same functions score every
// row, and every constant is computed from the snapshot at run time.

import { leastSquares, median, mulberry32, quantile } from './linalg.ts';

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-v3';

/** Slope prior (see the header): the curve's log-log slope, fixed, not fitted. */
export const SLOPE_PRIOR = 0.5;
/** The fitted multiple is clamped to this band before the growth factor. */
export const MULTIPLE_LOW = 0.08;
export const MULTIPLE_HIGH = 1.2;
/** The growth factor's weight on the 7-day TVL change. */
export const GROWTH_WEIGHT = 0.3;
/** The verdict ticket and drop share the board's verdicts are taken on. */
export const VERDICT_DEPOSIT = 1000;
export const VERDICT_DROP_SHARE = 0.07;
/** FARM when the net on the verdict ticket beats this many dollars. */
export const FARM_NET_THRESHOLD = 10;
/** Transactions the farm plan counts gas for (fund, deposit, 2 qualifying, claim). */
export const PLAN_TRANSACTIONS = 5;
/** Hours the farm plan takes (15m setup + 30m deposit + 2h weekly + 15m claim + 15m log). */
export const PLAN_HOURS = 3.25;
/** The review date is this many days after the snapshot. */
export const REVIEW_DAYS = 84;
/** The exit rule's TVL floor, as a fraction of the snapshot TVL. */
export const EXIT_TVL_FRACTION = 0.7;

/** Gas per transaction, in dollars, by first chain. Unlisted chains pay $1.50. */
export const GAS_PER_TX: Record<string, number> = {
  Ethereum: 6.0,
  Arbitrum: 0.2,
  Optimism: 0.2,
  Base: 0.2,
  BSC: 0.4,
  Solana: 0.05,
  Polygon: 0.1,
  Avalanche: 0.3,
  Unichain: 0.2,
  Katana: 0.2,
};

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A date `days` after `asOf`, as YYYY-MM-DD. */
export function addDays(asOf: string, days: number): string {
  const d = new Date(Date.parse(`${asOf}T00:00:00Z`) + days * DAY_MS);
  return d.toISOString().slice(0, 10);
}

/** Short dollars: 1234567 -> "$1.23M", 1234 -> "$1,234", 0.5 -> "$0.50". */
export function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`;
  if (n >= 100) return `$${Math.round(n).toLocaleString('en-US')}`;
  return `$${n.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// The comp set: traded protocols whose token is a claim on their own TVL.
// ---------------------------------------------------------------------------

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Exchange names a protocol name must not start with. */
const EXCHANGE_NAMES = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex'];

/**
 * Categories whose token is not a claim on the protocol's own TVL: an
 * exchange token, a bridge token, or a staking receipt (the receipt's
 * market cap tracks the staked asset, not a launch candidate).
 */
export const NON_CLAIM_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);

/** Whether a protocol records a token with a market value. */
export function hasToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0;
}

/** Whether a protocol is a comp: traded, with a known age, and a claim on its own TVL. */
export function isComp(p: SnapshotProtocol, asOf: string): boolean {
  if (!hasToken(p)) return false;
  if (p.tvl_usd <= 0) return false;
  if (ageDays(asOf, p.listed_at) === null) return false;
  if (NON_CLAIM_CATEGORIES.has(p.category ?? '')) return false;
  if (VERSIONED.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.toLowerCase().startsWith(e))) return false;
  return true;
}

/** Whether a protocol records no token at all under the house's rule (no gecko id, no symbol). */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol may be ranked: pre-token and not an exchange, bridge, receipt or versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (NON_CLAIM_CATEGORIES.has(p.category ?? '')) return false;
  if (VERSIONED.test(p.name)) return false;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.toLowerCase().startsWith(e))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The value curve: log-log fit with a fixed slope prior and shrunk offsets.
// ---------------------------------------------------------------------------

/** The fitted curve: intercept, fixed slope, age coefficient (0 in the main model), and per-category offsets. */
export interface CurveFit {
  intercept: number;
  slope: number;
  ageCoef: number;
  offsets: Record<string, number>;
  /** How the fit was obtained, for the dashboard's method note. */
  note: string;
}

/**
 * Fit ln(mcap) = a + slope x ln(TVL) + ageCoef x ln(age) + offset[category]
 * on the comps, by alternating least squares: the linear coefficients by
 * least squares given the offsets, then each offset as its shrunk mean
 * residual (n/(n+8) toward zero). `slope` null fits the slope too. The
 * main model calls this with slope 0.50 and age off; the ablation calls it
 * with the age term on and with a free slope.
 */
export function fitCurve(
  comps: SnapshotProtocol[],
  asOf: string,
  slope: number | null = SLOPE_PRIOR,
  useAge = false,
): CurveFit {
  const cats = [...new Set(comps.map((p) => p.category ?? '(null)'))].sort();
  const ci = new Map(cats.map((c, i) => [c, i]));
  const y = comps.map((p) => Math.log(p.mcap_usd!));
  const lt = comps.map((p) => Math.log(p.tvl_usd));
  const la = comps.map((p) => Math.log(Math.max(ageDays(asOf, p.listed_at) ?? 365, 1)));
  const offsets = new Array<number>(cats.length).fill(0);
  let intercept = 0;
  let fittedSlope = slope ?? 0.5;
  let ageCoef = 0;
  for (let iter = 0; iter < 300; iter++) {
    const r = y.map((v, i) => v - offsets[ci.get(comps[i]!.category ?? '(null)')!]!);
    const cols: number[][] = [new Array<number>(comps.length).fill(1)];
    if (slope === null) cols.push(lt);
    if (useAge) cols.push(la);
    const target = slope === null ? r : r.map((v, i) => v - slope * lt[i]!);
    const coef = leastSquares(cols, target);
    intercept = coef[0]!;
    let j = 1;
    if (slope === null) {
      fittedSlope = coef[j]!;
      j++;
    } else {
      fittedSlope = slope;
    }
    ageCoef = useAge ? coef[j]! : 0;
    const resid = y.map((v, i) => v - (intercept + fittedSlope * lt[i]! + ageCoef * la[i]!));
    const next = new Array<number>(cats.length).fill(0);
    let maxDelta = 0;
    for (let k = 0; k < cats.length; k++) {
      const idx: number[] = [];
      for (let i = 0; i < comps.length; i++) if (ci.get(comps[i]!.category ?? '(null)') === k) idx.push(i);
      const n = idx.length;
      const m = n === 0 ? 0 : (n / (n + 8)) * (idx.reduce((s, i) => s + resid[i]!, 0) / n);
      next[k] = m;
      maxDelta = Math.max(maxDelta, Math.abs(m - offsets[k]!));
    }
    for (let k = 0; k < cats.length; k++) offsets[k] = next[k]!;
    if (maxDelta < 1e-11) break;
  }
  const off: Record<string, number> = {};
  cats.forEach((c, k) => {
    off[c] = offsets[k]!;
  });
  return {
    intercept,
    slope: fittedSlope,
    ageCoef,
    offsets: off,
    note:
      slope === null
        ? 'OLS slope (ablation only)'
        : `slope fixed at the ${SLOPE_PRIOR} prior; intercept and offsets fitted${useAge ? '; age term on (ablation only)' : ''}`,
  };
}

/** The growth factor from the 7-day TVL change. The snapshot's change_7d is
 *  already a percent (+2.37 means +2.37%), so the clamp is in percent units
 *  and the division by 100 turns it into a fraction. */
export function growthFactor(p: SnapshotProtocol): number {
  const g = Math.min(120, Math.max(-60, finite(p.change_7d, 0)));
  return 1 + (g / 100) * GROWTH_WEIGHT;
}

/** The fitted multiple (value if it launches, per dollar of TVL, before growth), clamped. */
export function curveMultiple(p: SnapshotProtocol, fit: CurveFit, asOf: string): number {
  const age = ageDays(asOf, p.listed_at) ?? 365;
  const raw =
    Math.exp(
      fit.intercept +
        fit.slope * Math.log(p.tvl_usd) +
        fit.ageCoef * Math.log(Math.max(age, 1)) +
        (fit.offsets[p.category ?? '(null)'] ?? 0),
    ) / p.tvl_usd;
  return Math.min(MULTIPLE_HIGH, Math.max(MULTIPLE_LOW, raw));
}

/** Value if the protocol launches a token, in dollars. */
export function valueIfLaunches(p: SnapshotProtocol, fit: CurveFit, asOf: string): { value: number; multiple: number; growth: number } {
  const multiple = curveMultiple(p, fit, asOf);
  const growth = growthFactor(p);
  return { value: multiple * p.tvl_usd * growth, multiple, growth };
}

// ---------------------------------------------------------------------------
// Launch odds: a hazard/survival model fitted on the snapshot itself.
// ---------------------------------------------------------------------------

/** The fitted launch-time distribution and the global ever-launch rate. */
export interface HazardFit {
  /** Weibull shape. */
  k: number;
  /** Weibull scale, in days. */
  lam: number;
  /** P(a protocol ever launches), pooled. */
  pEver: number;
  /** Negative log-likelihood at the fit (for the record). */
  nll: number;
}

/** The Weibull CDF: the fraction of eventual launches that have happened by age `a` days. */
export function launchCdf(a: number | null, h: HazardFit): number {
  const age = (a ?? 365) + 1;
  return 1 - Math.exp(-Math.pow(age / h.lam, h.k));
}

/**
 * Fit the launch-time Weibull by maximum likelihood on the snapshot's
 * current-status data: each protocol is observed at its age with a token
 * (launched by then) or without (not yet). P(has token | age a) =
 * pEver x F(a). The grid is coarse, then refined around the best point;
 * the same grid every run, so the fit is deterministic.
 */
export function fitHazard(protocols: SnapshotProtocol[], asOf: string): HazardFit {
  const known = protocols
    .map((p) => ({ age: ageDays(asOf, p.listed_at), token: hasToken(p) }))
    .filter((x): x is { age: number; token: boolean } => x.age !== null);
  const nll = (k: number, lam: number, p: number): number => {
    let s = 0;
    for (const x of known) {
      const F = 1 - Math.exp(-Math.pow((x.age + 1) / lam, k));
      const q = Math.min(1 - 1e-9, Math.max(1e-9, p * F));
      s -= x.token ? Math.log(q) : Math.log(1 - q);
    }
    return s;
  };
  let best = { v: Infinity, k: 0.8, lam: 3000, p: 0.56 };
  const tryPoint = (k: number, lam: number, p: number) => {
    const v = nll(k, lam, p);
    if (v < best.v) best = { v, k, lam, p };
  };
  for (const k of [0.6, 0.8, 1.0, 1.2, 1.5, 1.8, 2.2])
    for (const lam of [200, 400, 700, 1000, 1500, 2500, 4000, 7000])
      for (const p of [0.3, 0.35, 0.4, 0.45, 0.5, 0.6]) tryPoint(k, lam, p);
  const bk = best.k;
  const bl = best.lam;
  const bp = best.p;
  for (let ki = -3; ki <= 3; ki++)
    for (let li = -3; li <= 3; li++)
      for (let pi = -4; pi <= 4; pi++)
        tryPoint(bk + ki * 0.1, bl * (1 + li * 0.1), bp + pi * 0.02);
  return { k: best.k, lam: best.lam, pEver: best.p, nll: best.v };
}

/**
 * P(ever launches) per category, by a moment estimator: the category's
 * token rate divided by the mean launch-CDF over its protocols' ages,
 * shrunk toward the pooled rate with strength 15 and capped at [0.05, 0.85].
 * A category with no age-known protocol takes the pooled rate.
 */
export function categoryEverRates(protocols: SnapshotProtocol[], asOf: string, h: HazardFit): Record<string, number> {
  const byCat = new Map<string, SnapshotProtocol[]>();
  for (const p of protocols) {
    const c = p.category ?? '(null)';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(p);
  }
  const out: Record<string, number> = {};
  for (const [c, rows] of byCat) {
    const aged = rows.filter((p) => ageDays(asOf, p.listed_at) !== null);
    if (aged.length === 0) {
      out[c] = h.pEver;
      continue;
    }
    const meanF = aged.reduce((s, p) => s + launchCdf(ageDays(asOf, p.listed_at), h), 0) / aged.length;
    const rate = rows.filter(hasToken).length / rows.length;
    const raw = rate / Math.max(meanF, 0.05);
    const n = rows.length;
    out[c] = Math.min(0.85, Math.max(0.05, (n * raw + 15 * h.pEver) / (n + 15)));
  }
  return out;
}

/**
 * The forward launch odds for a protocol of this age and category:
 * odds = [P(ever) - P(ever) x F(a)] / [1 - P(ever) x F(a)].
 * Old for its category and still tokenless, a protocol's odds fall — the
 * hazard form, not the cumulative rate (which points the wrong way).
 */
export function launchOdds(
  age: number | null,
  category: string | null,
  h: HazardFit,
  ever: Record<string, number>,
): { odds: number; pEver: number; F: number } {
  const pEver = ever[category ?? '(null)'] ?? h.pEver;
  const F = launchCdf(age, h);
  const odds = (pEver * (1 - F)) / (1 - pEver * F);
  return { odds, pEver, F };
}

// ---------------------------------------------------------------------------
// Net, verdict, farm plan.
// ---------------------------------------------------------------------------

/** Gas per transaction for a protocol's first chain. */
export function gasPerTx(p: SnapshotProtocol): number {
  const chain = p.chains.length > 0 ? p.chains[0]! : '';
  return GAS_PER_TX[chain] ?? 1.5;
}

/** Total gas for the plan's five transactions. */
export function planGas(p: SnapshotProtocol): number {
  return PLAN_TRANSACTIONS * gasPerTx(p);
}

/** The expected drop on a deposit at a drop share, in dollars. */
export function expectedDrop(deposit: number, implied: number, tvl: number, share: number): number {
  return (deposit / tvl) * implied * share;
}

/** Net dollars on a deposit at a drop share, after gas. */
export function netOn(deposit: number, implied: number, tvl: number, share: number, gas: number): number {
  return expectedDrop(deposit, implied, tvl, share) - gas;
}

/** The verdict from the net on the verdict ticket. */
export function verdictFromNet(net: number): 'FARM' | 'THIN' | 'SKIP' {
  if (net > FARM_NET_THRESHOLD) return 'FARM';
  if (net > 0) return 'THIN';
  return 'SKIP';
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, deposit: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Supply $${deposit.toLocaleString('en-US')} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm'))
    return `Provide $${deposit.toLocaleString('en-US')} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge'))
    return `Bridge $${deposit.toLocaleString('en-US')} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak'))
    return `Stake $${deposit.toLocaleString('en-US')} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative'))
    return `Deposit $${deposit.toLocaleString('en-US')} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${deposit.toLocaleString('en-US')} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator'))
    return `Deposit $${deposit.toLocaleString('en-US')} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${deposit.toLocaleString('en-US')} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${deposit.toLocaleString('en-US')} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${deposit.toLocaleString('en-US')} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${deposit.toLocaleString('en-US')} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps with real numbers — the deposit, the
 * expected drop and net on the verdict ticket, the gas per step, the review
 * date, and the TVL exit rule. Weekly checks are reads and off-chain votes
 * and cost no gas; gas counts five transactions (fund, deposit, two
 * qualifying actions, claim).
 */
export function farmSteps(
  p: SnapshotProtocol,
  implied: number,
  reviewDate: string,
  asOf: string,
): FarmStep[] {
  const chain = chainOf(p);
  const gasTx = gasPerTx(p);
  const gas = planGas(p);
  const drop = expectedDrop(VERDICT_DEPOSIT, implied, p.tvl_usd, VERDICT_DROP_SHARE);
  const net = drop - gas;
  const exitTvl = Math.round((EXIT_TVL_FRACTION * p.tvl_usd) / 1000) * 1000;
  void asOf;
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: `1 transaction, about $${gasTx.toFixed(2)} of gas`,
      time: '15 minutes',
    },
    {
      text:
        `${actionFor(p, VERDICT_DEPOSIT, chain)} ` +
        `At a 7% drop share the model's expected drop on $${VERDICT_DEPOSIT.toLocaleString('en-US')} is $${drop.toFixed(2)}; after $${gas.toFixed(2)} of gas the net is ${net >= 0 ? '+' : ''}$${net.toFixed(2)}.`,
      cost: `$${VERDICT_DEPOSIT.toLocaleString('en-US')} of capital and about $${gasTx.toFixed(2)} of gas`,
      time: '30 minutes to set up',
    },
    {
      text: `Make a qualifying action twice in the window, such as a deposit, a borrow, a swap or a vote, and check the points page every week.`,
      cost: `2 transactions, about $${(2 * gasTx).toFixed(2)} of gas; reads and votes cost nothing`,
      time: '10 minutes a week',
    },
    {
      text:
        `Hold the position for at least ${REVIEW_DAYS} days and review it on ${reviewDate}. ` +
        `Withdraw if TVL falls under ${fmtUsd(exitTvl)}, if withdrawals are paused, or once a token is announced.`,
      cost: `the $${VERDICT_DEPOSIT.toLocaleString('en-US')} stays in the position`,
      time: `${REVIEW_DAYS} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: `1 transaction, about $${gasTx.toFixed(2)} of gas`,
      time: '15 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '15 minutes',
    },
  ];
}

// ---------------------------------------------------------------------------
// The board.
// ---------------------------------------------------------------------------

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  value_if_launches_usd: number;
  launch_odds: number;
  launch_p_ever: number;
  launch_f_age: number;
  multiple: number;
  growth_multiplier: number;
  net_usd: number;
  net_per_hour_usd: number;
  gas_usd: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  farm_steps: string[];
  comparables: { slug: string; name: string; tvl_usd: number; mcap_usd: number }[];
  peers_n: number;
  peers_with_token: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  value_if_launches_usd: number;
  launch_odds: number;
  launch_p_ever: number;
  launch_f_age: number;
  multiple: number;
  growth_multiplier: number;
  net_usd: number;
  net_per_hour_usd: number;
  gas_usd: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  peers_n: number;
  peers_with_token: number;
  rank_p10: number;
  rank_p90: number;
  rank_min: number;
  rank_max: number;
  comparables: { slug: string; name: string; tvl_usd: number; mcap_usd: number }[];
  farm_steps: string[];
}

/** A comp for the scatter: a traded protocol with its TVL and market cap. */
export interface CompPoint {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  age_days: number;
}

/** Everything the dashboard needs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  total_implied_usd: number;
  model: {
    slope: number;
    slope_note: string;
    intercept: number;
    offsets: Record<string, number>;
    multiple_low: number;
    multiple_high: number;
    growth_weight: number;
    comps_n: number;
    comps_rule: string;
    hazard_k: number;
    hazard_lam: number;
    hazard_p_ever: number;
    verdict_deposit: number;
    verdict_drop_share: number;
    farm_net_threshold: number;
    plan_transactions: number;
    plan_hours: number;
    review_date: string;
  };
  validation: {
    loo_median: number;
    loo_mean: number;
    walk_forward_median: number;
    time_split_median: number;
    range_hold: number;
    range_hold_n: number;
    range_hold_denom: number;
    spearman: number;
    ablation: { variant: string; loo_median: number; note: string }[];
    rejected: { variant: string; reason: string }[];
  };
  ledger: { label: string; n: number; note: string }[];
  watchlist_slugs: string[];
  groups: {
    token_trades: { slug: string; name: string; category: string | null; tvl_usd: number; mcap_usd: number }[];
    set_aside: { slug: string; name: string; category: string | null; reason: string }[];
  };
  rows: RadarRow[];
  comps: CompPoint[];
  live: LiveRow[];
}

/** The headline figures: how many watchlist slugs, how many rows. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
}

/** The three nearest traded comparables, by distance in (ln TVL, ln age). */
export function nearestComparables(
  p: SnapshotProtocol,
  comps: SnapshotProtocol[],
  asOf: string,
): { slug: string; name: string; tvl_usd: number; mcap_usd: number }[] {
  const age = ageDays(asOf, p.listed_at) ?? 365;
  const scored = comps
    .filter((c) => c.slug !== p.slug)
    .map((c) => {
      const ca = ageDays(asOf, c.listed_at) ?? 365;
      const d = Math.abs(Math.log(p.tvl_usd / c.tvl_usd)) + 0.5 * Math.abs(Math.log(Math.max(age, 1) / Math.max(ca, 1)));
      return { c, d };
    })
    .sort((a, b) => a.d - b.d || (a.c.slug < b.c.slug ? -1 : 1))
    .slice(0, 3);
  return scored.map(({ c }) => ({ slug: c.slug, name: c.name, tvl_usd: c.tvl_usd, mcap_usd: c.mcap_usd! }));
}

/** Score one protocol into a board row (rank assigned later). */
export function scoreRow(
  p: SnapshotProtocol,
  fit: CurveFit,
  h: HazardFit,
  ever: Record<string, number>,
  comps: SnapshotProtocol[],
  allProtocols: SnapshotProtocol[],
  asOf: string,
  reviewDate: string,
): BoardRow {
  const age = ageDays(asOf, p.listed_at);
  const { value, multiple, growth } = valueIfLaunches(p, fit, asOf);
  const { odds, pEver, F } = launchOdds(age, p.category, h, ever);
  const implied = Math.max(1, Math.round(value * odds));
  const gas = planGas(p);
  const net = netOn(VERDICT_DEPOSIT, implied, p.tvl_usd, VERDICT_DROP_SHARE, gas);
  const peers = allProtocols.filter((x) => (x.category ?? '(null)') === (p.category ?? '(null)'));
  const peersWithToken = peers.filter(hasToken).length;
  return {
    rank: 0,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token',
    age_days: age,
    implied_value_usd: implied,
    value_if_launches_usd: Math.round(value),
    launch_odds: Math.round(odds * 1000) / 1000,
    launch_p_ever: Math.round(pEver * 1000) / 1000,
    launch_f_age: Math.round(F * 1000) / 1000,
    multiple: Math.round(multiple * 10000) / 10000,
    growth_multiplier: Math.round(growth * 10000) / 10000,
    net_usd: Math.round(net * 100) / 100,
    net_per_hour_usd: Math.round((net / PLAN_HOURS) * 100) / 100,
    gas_usd: Math.round(gas * 100) / 100,
    verdict: verdictFromNet(net),
    farm_steps: farmSteps(p, implied, reviewDate, asOf).map(stepText),
    comparables: nearestComparables(p, comps, asOf),
    peers_n: peers.length,
    peers_with_token: peersWithToken,
  };
}

/** The ranked board: every rankable pre-token protocol, strongest first, ranks 1..n. */
export function buildBoard(
  snapshot: Snapshot,
  fit: CurveFit,
  h: HazardFit,
  ever: Record<string, number>,
): BoardRow[] {
  const reviewDate = addDays(snapshot.as_of, REVIEW_DAYS);
  const comps = snapshot.protocols.filter((p) => isComp(p, snapshot.as_of));
  const ranked = snapshot.protocols.filter(isRankable);
  const rows = ranked.map((p) => scoreRow(p, fit, h, ever, comps, snapshot.protocols, snapshot.as_of, reviewDate));
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  return rows;
}

/** The live-token protocols, by market cap, for the dashboard's Token trades view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => hasToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The ledger: every one of the snapshot's protocols, accounted for. */
export function buildLedger(snapshot: Snapshot): { label: string; n: number; note: string }[] {
  let trades = 0;
  let symbolOnly = 0;
  let ranked = 0;
  const setAside = new Map<string, number>();
  for (const p of snapshot.protocols) {
    if (hasToken(p) || p.gecko_id !== null) {
      trades++;
    } else if (!isPreToken(p)) {
      symbolOnly++;
    } else if (isRankable(p)) {
      ranked++;
    } else if (NON_CLAIM_CATEGORIES.has(p.category ?? '')) {
      setAside.set(`category ${p.category}`, (setAside.get(`category ${p.category}`) ?? 0) + 1);
    } else if (VERSIONED.test(p.name)) {
      setAside.set('versioned name', (setAside.get('versioned name') ?? 0) + 1);
    } else if (/\b(wrapped|staked|staking)\b/i.test(p.name)) {
      setAside.set('wrapped / staked name', (setAside.get('wrapped / staked name') ?? 0) + 1);
    } else if (EXCHANGE_NAMES.some((e) => p.name.toLowerCase().startsWith(e))) {
      setAside.set('exchange name', (setAside.get('exchange name') ?? 0) + 1);
    } else {
      setAside.set('other', (setAside.get('other') ?? 0) + 1);
    }
  }
  const rows: { label: string; n: number; note: string }[] = [
    { label: 'Ranked on the board', n: ranked, note: 'every rankable pre-token protocol, watchlist first' },
    { label: 'Token trades', n: trades, note: 'a market cap or a CoinGecko id is recorded' },
    { label: 'Symbol only, no market cap', n: symbolOnly, note: 'a token is recorded but unpriced — not ranked, not priced' },
  ];
  for (const [label, n] of [...setAside.entries()].sort((a, b) => b[1] - a[1])) {
    rows.push({ label: `Set aside: ${label}`, n, note: 'pre-token but not a launch candidate under the board rule' });
  }
  return rows;
}

/** The two off-board groups as rows, so the page's tabs show real protocols, not just counts. */
export function buildGroups(snapshot: Snapshot): {
  token_trades: { slug: string; name: string; category: string | null; tvl_usd: number; mcap_usd: number }[];
  set_aside: { slug: string; name: string; category: string | null; reason: string }[];
} {
  const token_trades: { slug: string; name: string; category: string | null; tvl_usd: number; mcap_usd: number }[] = [];
  const set_aside: { slug: string; name: string; category: string | null; reason: string }[] = [];
  for (const p of snapshot.protocols) {
    if (hasToken(p) || p.gecko_id !== null) {
      token_trades.push({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd ?? 0 });
    } else if (isPreToken(p) && !isRankable(p)) {
      let reason = 'other';
      if (NON_CLAIM_CATEGORIES.has(p.category ?? '')) reason = `category ${p.category}`;
      else if (VERSIONED.test(p.name)) reason = 'versioned name';
      else if (/\b(wrapped|staked|staking)\b/i.test(p.name)) reason = 'wrapped / staked name';
      else if (EXCHANGE_NAMES.some((e) => p.name.toLowerCase().startsWith(e))) reason = 'exchange name';
      set_aside.push({ slug: p.slug, name: p.name, category: p.category, reason });
    }
  }
  token_trades.sort((a, b) => b.mcap_usd - a.mcap_usd || (a.slug < b.slug ? -1 : 1));
  set_aside.sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  return { token_trades, set_aside };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

/** Rank ranges from bootstrap refits: for each board slug, p10/p90/min/max rank. */
export function bootstrapRankRanges(
  board: BoardRow[],
  comps: SnapshotProtocol[],
  snapshot: Snapshot,
  fit: CurveFit,
  h: HazardFit,
  ever: Record<string, number>,
  refits = 200,
  seed = 20261114,
): Map<string, { p10: number; p90: number; min: number; max: number }> {
  const rng = new Map<string, number[]>();
  for (const r of board) rng.set(r.slug, []);
  const rand = mulberry32(seed);
  for (let b = 0; b < refits; b++) {
    const sample: SnapshotProtocol[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rand() * comps.length)]!);
    const refit = fitCurve(sample, snapshot.as_of, SLOPE_PRIOR);
    const rows = buildBoard(snapshot, refit, h, ever);
    for (const r of rows) rng.get(r.slug)!.push(r.rank);
  }
  const out = new Map<string, { p10: number; p90: number; min: number; max: number }>();
  for (const [slug, ranks] of rng) {
    const sorted = [...ranks].sort((a, b) => a - b);
    out.set(slug, {
      p10: Math.round(quantile(sorted, 0.1)),
      p90: Math.round(quantile(sorted, 0.9)),
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
    });
  }
  return out;
}

/** Spearman rank correlation between implied-value rank and TVL rank. */
export function spearman(board: BoardRow[]): number {
  const byTvl = [...board].sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  const tvlRank = new Map(byTvl.map((r, i) => [r.slug, i + 1]));
  const n = board.length;
  let d2 = 0;
  for (const r of board) {
    const d = r.rank - tvlRank.get(r.slug)!;
    d2 += d * d;
  }
  return 1 - (6 * d2) / (n * (n * n - 1));
}

export { median };
