// Small linear algebra for the token radar's fits: solve the normal equations
// of a least-squares problem by Gaussian elimination with partial pivoting.
// Node standard library only; no dependencies. All numbers are plain floats.

/** Solve A x = b for a small dense square system. Throws on a singular matrix. */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M: number[][] = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) throw new Error('solveLinear: singular matrix');
    if (piv !== col) {
      const tmp = M[col]!;
      M[col] = M[piv]!;
      M[piv] = tmp;
    }
    const d = M[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i]![n]!;
    for (let j = i + 1; j < n; j++) s -= M[i]![j]! * x[j]!;
    x[i] = s / M[i]![i]!;
  }
  return x;
}

/**
 * Least squares for y ~ X beta, via the normal equations (X'X) beta = X'y.
 * `cols` is an array of column vectors (each the same length as y).
 */
export function leastSquares(cols: number[][], y: number[]): number[] {
  const k = cols.length;
  const n = y.length;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let r = 0; r < n; r++) s += cols[i]![r]! * cols[j]![r]!;
      A[i]![j] = s;
    }
    let s = 0;
    for (let r = 0; r < n; r++) s += cols[i]![r]! * y[r]!;
    b[i] = s;
  }
  return solveLinear(A, b);
}

/** A deterministic PRNG (mulberry32) for the bootstrap refits. Same seed, same draws. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Median of a list of numbers (a copy is sorted; the input is untouched). */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/** Quantile by linear interpolation on the sorted copy. */
export function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
