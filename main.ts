// Token Radar v3 — the entry program (Node 22+, standard library only).
//
// Reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>),
// fits the value curve and the launch-odds hazard model from the snapshot,
// scores every rankable pre-token protocol, validates the model out of
// sample, writes the ranked board to /output/board.json, writes the
// dashboard's data into /output/data.js, copies dashboard/ and screenshots/
// to /output, and writes /output/dossier.json with the vendored make.fun
// library — as the starter's main.ts does.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addDays,
  ageDays,
  boardIssue,
  bootstrapRankRanges,
  buildBoard,
  buildGroups,
  buildLedger,
  categoryEverRates,
  dataScript,
  fitCurve,
  fitHazard,
  FARM_NET_THRESHOLD,
  fmtUsd,
  GROWTH_WEIGHT,
  isComp,
  liveRows,
  MODEL_VERSION,
  MULTIPLE_HIGH,
  MULTIPLE_LOW,
  parseSnapshot,
  PLAN_HOURS,
  PLAN_TRANSACTIONS,
  REVIEW_DAYS,
  SLOPE_PRIOR,
  spearman,
  VERDICT_DEPOSIT,
  VERDICT_DROP_SHARE,
  type BoardRow,
  type RadarData,
  type RadarRow,
} from './lib/model.ts';
import { validate } from './lib/validate.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));

// --- fit -------------------------------------------------------------------
const comps = snapshot.protocols.filter((p) => isComp(p, snapshot.as_of));
const fit = fitCurve(comps, snapshot.as_of, SLOPE_PRIOR, false);
const hazard = fitHazard(snapshot.protocols, snapshot.as_of);
const ever = categoryEverRates(snapshot.protocols, snapshot.as_of, hazard);

// --- board -----------------------------------------------------------------
const board: BoardRow[] = buildBoard(snapshot, fit, hazard, ever);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

// --- validation + rank ranges ----------------------------------------------
const validation = validate(snapshot, fit);
const ranges = bootstrapRankRanges(board, comps, snapshot, fit, hazard, ever);

// --- dashboard data ---------------------------------------------------------
const reviewDate = addDays(snapshot.as_of, REVIEW_DAYS);
const totalImplied = board.reduce((s, r) => s + r.implied_value_usd, 0);
const farmRows = board.filter((r) => r.verdict === 'FARM');
const bestPerHour = farmRows.length > 0 ? Math.max(...farmRows.map((r) => r.net_per_hour_usd)) : 0;
const rows: RadarRow[] = board.map((r) => {
  const rg = ranges.get(r.slug)!;
  return {
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    age_days: r.age_days,
    implied_value_usd: r.implied_value_usd,
    value_if_launches_usd: r.value_if_launches_usd,
    launch_odds: r.launch_odds,
    launch_p_ever: r.launch_p_ever,
    launch_f_age: r.launch_f_age,
    multiple: r.multiple,
    growth_multiplier: r.growth_multiplier,
    net_usd: r.net_usd,
    net_per_hour_usd: r.net_per_hour_usd,
    gas_usd: r.gas_usd,
    verdict: r.verdict,
    peers_n: r.peers_n,
    peers_with_token: r.peers_with_token,
    rank_p10: rg.p10,
    rank_p90: rg.p90,
    rank_min: rg.min,
    rank_max: rg.max,
    comparables: r.comparables,
    farm_steps: r.farm_steps,
  };
});
const radar: RadarData = {
  as_of: snapshot.as_of,
  source: snapshot.source,
  floor_usd: snapshot.floor_usd,
  model_version: MODEL_VERSION,
  watchlist_size: snapshot.watchlist.length,
  board_size: board.length,
  total_implied_usd: totalImplied,
  model: {
    slope: fit.slope,
    slope_note: fit.note,
    intercept: Math.round(fit.intercept * 1000) / 1000,
    offsets: Object.fromEntries(Object.entries(fit.offsets).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
    multiple_low: MULTIPLE_LOW,
    multiple_high: MULTIPLE_HIGH,
    growth_weight: GROWTH_WEIGHT,
    comps_n: comps.length,
    comps_rule:
      'traded (mcap > 0), TVL > 0, age known; excludes CEX, bridges, liquid staking / restaking receipts, versioned names, exchange names',
    hazard_k: Math.round(hazard.k * 100) / 100,
    hazard_lam: Math.round(hazard.lam),
    hazard_p_ever: Math.round(hazard.pEver * 1000) / 1000,
    verdict_deposit: VERDICT_DEPOSIT,
    verdict_drop_share: VERDICT_DROP_SHARE,
    farm_net_threshold: FARM_NET_THRESHOLD,
    plan_transactions: PLAN_TRANSACTIONS,
    plan_hours: PLAN_HOURS,
    review_date: reviewDate,
  },
  validation: {
    loo_median: Math.round(validation.looMedian * 100) / 100,
    loo_mean: Math.round(validation.looMean * 100) / 100,
    walk_forward_median: Math.round(validation.walkForwardMedian * 100) / 100,
    time_split_median: Math.round(validation.timeSplitMedian * 100) / 100,
    range_hold: Math.round(validation.rangeHold * 1000) / 1000,
    range_hold_n: validation.rangeHoldN,
    range_hold_denom: validation.rangeHoldDenom,
    spearman: Math.round(spearman(board) * 1000) / 1000,
    ablation: validation.ablation.map((a) => ({
      variant: a.variant,
      loo_median: Math.round(a.looMedian * 100) / 100,
      note: a.note,
    })),
    rejected: validation.rejected,
  },
  ledger: buildLedger(snapshot),
  watchlist_slugs: snapshot.watchlist,
  groups: buildGroups(snapshot),
  rows,
  comps: comps.map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd!,
    age_days: ageDays(snapshot.as_of, p.listed_at)!,
  })),
  live: liveRows(snapshot),
};

// --- write ------------------------------------------------------------------
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${board.length - snapshot.watchlist.length} beyond the watchlist)\n` +
    `token radar: total implied ${fmtUsd(totalImplied)}, ${farmRows.length} FARM, best ${fmtUsd(bestPerHour)}/h\n` +
    `token radar: curve slope ${fit.slope} intercept ${fit.intercept.toFixed(3)} on ${comps.length} comps; hazard k=${hazard.k.toFixed(2)} lam=${Math.round(hazard.lam)}d pEver=${hazard.pEver.toFixed(2)}\n` +
    `token radar: LOO x${validation.looMedian.toFixed(2)} walk-forward x${validation.walkForwardMedian.toFixed(2)} time-split x${validation.timeSplitMedian.toFixed(2)} range-hold ${(validation.rangeHold * 100).toFixed(0)}%\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
