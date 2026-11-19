// Token Radar v3 — out-of-sample validation, computed from the snapshot by
// the entry itself (so the dashboard's numbers are the program's numbers,
// not typed in by hand). LOO is a guard, not the gate: the age term's story
// below is why — it helps LOO slightly and destroys walk-forward, so the
// main model leaves it out and the ablation shows all three variants.

import { median } from './linalg.ts';
import {
  ageDays,
  fitCurve,
  hasToken,
  isComp,
  type CurveFit,
  type Snapshot,
  type SnapshotProtocol,
} from './model.ts';

/** One validation figure: the median absolute multiple error, as a ratio (x2.94 means the typical miss is 2.94x). */
export interface ValidationResult {
  looMedian: number;
  looMean: number;
  walkForwardMedian: number;
  walkForwardTrain: number;
  walkForwardTest: number;
  timeSplitMedian: number;
  timeSplitTrain: number;
  timeSplitTest: number;
  rangeHold: number;
  rangeHoldN: number;
  rangeHoldDenom: number;
  ablation: { variant: string; looMedian: number; note: string }[];
  rejected: { variant: string; reason: string }[];
}

/** The predicted market cap of a comp under a fit (multiple, before the growth factor — comps are priced on the curve alone). */
function predictedMcap(p: SnapshotProtocol, fit: CurveFit, asOf: string): number {
  const age = ageDays(asOf, p.listed_at) ?? 365;
  return Math.exp(
    fit.intercept +
      fit.slope * Math.log(p.tvl_usd) +
      fit.ageCoef * Math.log(Math.max(age, 1)) +
      (fit.offsets[p.category ?? '(null)'] ?? 0),
  );
}

/** The absolute ratio error of one comp's prediction. */
function ratioError(p: SnapshotProtocol, fit: CurveFit, asOf: string): number {
  const pred = predictedMcap(p, fit, asOf);
  const r = p.mcap_usd! / pred;
  return Math.max(r, 1 / r);
}

/** Leave-one-out: refit without each comp in turn, predict it. Returns the median and mean ratio. */
export function looAll(
  comps: SnapshotProtocol[],
  asOf: string,
  slope: number | null,
  useAge: boolean,
): { median: number; mean: number } {
  const errs: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const sub = comps.filter((_, j) => j !== i);
    const fit = fitCurve(sub, asOf, slope, useAge);
    errs.push(ratioError(comps[i]!, fit, asOf));
  }
  return { median: median(errs), mean: errs.reduce((s, v) => s + v, 0) / errs.length };
}

/**
 * Walk-forward: fit on the comps listed before 2025-01-01, test on the ones
 * listed after. Training on the past, testing on the future — the closest
 * this cross-section gets to "what the model would have said then".
 */
export function walkForward(
  comps: SnapshotProtocol[],
  asOf: string,
  slope: number | null,
  useAge: boolean,
): { med: number; nTrain: number; nTest: number } {
  const cut = Date.parse('2025-01-01T00:00:00Z');
  const train = comps.filter((p) => Date.parse(`${p.listed_at}T00:00:00Z`) < cut);
  const test = comps.filter((p) => Date.parse(`${p.listed_at}T00:00:00Z`) >= cut);
  const fit = fitCurve(train, asOf, slope, useAge);
  const errs = test.map((p) => ratioError(p, fit, asOf));
  return { med: median(errs), nTrain: train.length, nTest: test.length };
}

/** Time split: fit on the oldest half by listing date, test on the newest half. */
export function timeSplit(
  comps: SnapshotProtocol[],
  asOf: string,
  slope: number | null,
  useAge: boolean,
): { med: number; nTrain: number; nTest: number } {
  const sorted = [...comps].sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const h = Math.floor(sorted.length / 2);
  const fit = fitCurve(sorted.slice(0, h), asOf, slope, useAge);
  const errs = sorted.slice(h).map((p) => ratioError(p, fit, asOf));
  return { med: median(errs), nTrain: h, nTest: sorted.length - h };
}

/** Range-hold: the fraction of comps whose actual market cap falls within 3x of the curve's prediction. */
export function rangeHold(
  comps: SnapshotProtocol[],
  asOf: string,
  fit: CurveFit,
): { rate: number; n: number; denom: number } {
  let inside = 0;
  for (const p of comps) {
    const pred = predictedMcap(p, fit, asOf);
    if (pred / 3 <= p.mcap_usd! && p.mcap_usd! <= pred * 3) inside++;
  }
  return { rate: inside / comps.length, n: inside, denom: comps.length };
}

/** The full validation suite for the main model, plus the ablation table. */
export function validate(snapshot: Snapshot, fit: CurveFit): ValidationResult {
  const asOf = snapshot.as_of;
  const comps = snapshot.protocols.filter((p) => isComp(p, asOf));
  const loo = looAll(comps, asOf, 0.5, false);
  const looMed = loo.median;
  const looMn = loo.mean;
  const wf = walkForward(comps, asOf, 0.5, false);
  const ts = timeSplit(comps, asOf, 0.5, false);
  const rh = rangeHold(comps, asOf, fit);
  const ageWf = walkForward(comps, asOf, 0.5, true);
  const ageLoo = looAll(comps, asOf, 0.5, true).median;
  const ablation: { variant: string; looMedian: number; note: string }[] = [
    {
      variant: 'Main: slope 0.50, no age, offsets',
      looMedian: looMed,
      note: 'the board model',
    },
    {
      variant: 'Age term on (slope 0.50)',
      looMedian: ageLoo,
      note: `LOO a touch better, walk-forward x${ageWf.med.toFixed(2)} — rejected (see below)`,
    },
    {
      variant: 'No offsets',
      looMedian: noOffsetLoo(comps, asOf),
      note: 'offsets carry the category premia',
    },
    {
      variant: 'Slope 0.45',
      looMedian: looAll(comps, asOf, 0.45, false).median,
      note: 'flatter prior, same family',
    },
    {
      variant: 'Slope 0.55',
      looMedian: looAll(comps, asOf, 0.55, false).median,
      note: 'steeper prior, same family',
    },
    {
      variant: 'OLS slope (free, 0.26)',
      looMedian: looAll(comps, asOf, null, false).median,
      note: 'the data-fit slope; values the giants too high',
    },
  ];
  const rejected: { variant: string; reason: string }[] = [
    {
      variant: 'Age term ln(age)',
      reason: `LOO x${ageLoo.toFixed(2)} vs x${looMed.toFixed(2)} without it, but walk-forward x${ageWf.med.toFixed(2)} vs x${wf.med.toFixed(2)} — the age pattern is a cohort effect (young test protocols run 2x the train set multiples) that does not travel forward, so the term is left out.`,
    },
    {
      variant: 'Huber / LAD robust fit',
      reason:
        'Downweights the high-multiple young tokens the board is trying to price; the median-based LOO already limits their influence, so a robust fit buys little and hides the outliers instead of showing them.',
    },
    {
      variant: 'Spline / quadratic in ln(TVL)',
      reason:
        'A flexible curve bends up at the top end, where the board needs it flat; it would chase the same high-multiple young tokens the flat prior refuses to chase.',
    },
    {
      variant: 'Slope per category',
      reason:
        'Most categories have under 10 comps; per-category slopes are noise (standard errors wider than the slope itself). One slope, shrunk offsets.',
    },
    {
      variant: 'Pre-token discount 0.80',
      reason:
        'A flat multiplier on every pre-token protocol — pure bias with no basis in the data. Launch odds replace it, per protocol, from the snapshot.',
    },
    {
      variant: 'Cumulative token rate as odds',
      reason:
        'P(has token | age) rises with age, so using it as odds would say old tokenless protocols are the most likely to launch — backwards. The hazard form is used instead.',
    },
  ];
  return {
    looMedian: looMed,
    looMean: looMn,
    walkForwardMedian: wf.med,
    walkForwardTrain: wf.nTrain,
    walkForwardTest: wf.nTest,
    timeSplitMedian: ts.med,
    timeSplitTrain: ts.nTrain,
    timeSplitTest: ts.nTest,
    rangeHold: rh.rate,
    rangeHoldN: rh.n,
    rangeHoldDenom: rh.denom,
    ablation,
    rejected,
  };
}

/** LOO with the offsets switched off (the no-offset ablation row). */
function noOffsetLoo(comps: SnapshotProtocol[], asOf: string): number {
  const errs: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const sub = comps.filter((_, j) => j !== i);
    const fit = fitCurve(sub, asOf, 0.5, false);
    const stripped: CurveFit = { ...fit, offsets: {} };
    errs.push(ratioError(comps[i]!, stripped, asOf));
  }
  return median(errs);
}

export { hasToken };
