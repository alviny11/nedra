/** Small dense linear algebra and scalar root finding used by the network solvers. */

/**
 * Solve A x = b in place by Gaussian elimination with partial pivoting.
 * A is row-major n*n. Returns null for a (numerically) singular matrix.
 */
export function solveDense(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const a = A;
  const x = b;
  for (let k = 0; k < n; k++) {
    let piv = k;
    let maxAbs = Math.abs(a[k * n + k]!);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(a[i * n + k]!);
      if (v > maxAbs) {
        maxAbs = v;
        piv = i;
      }
    }
    if (!(maxAbs > 1e-300)) return null;
    if (piv !== k) {
      for (let j = 0; j < n; j++) {
        const t = a[k * n + j]!;
        a[k * n + j] = a[piv * n + j]!;
        a[piv * n + j] = t;
      }
      const tb = x[k]!;
      x[k] = x[piv]!;
      x[piv] = tb;
    }
    const akk = a[k * n + k]!;
    for (let i = k + 1; i < n; i++) {
      const f = a[i * n + k]! / akk;
      if (f === 0) continue;
      for (let j = k; j < n; j++) a[i * n + j] = a[i * n + j]! - f * a[k * n + j]!;
      x[i] = x[i]! - f * x[k]!;
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i]!;
    for (let j = i + 1; j < n; j++) s -= a[i * n + j]! * x[j]!;
    x[i] = s / a[i * n + i]!;
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(x[i]!)) return null;
  return x;
}

/**
 * Root of a monotone function on (-inf, inf) using Newton steps safeguarded by bracketing.
 * `fdf` returns [f(x), f'(x)]. `increasing` tells the monotonicity direction.
 */
export function solveMonotone(
  fdf: (x: number) => [number, number],
  x0: number,
  scale: number,
  increasing: boolean,
  tol = 1e-12,
  maxIter = 100
): number {
  let lo = Number.NaN;
  let hi = Number.NaN; // lo: f<0 side, hi: f>0 side (in terms of "increasing" orientation)
  let x = x0;
  const sgn = increasing ? 1 : -1;
  for (let it = 0; it < maxIter; it++) {
    const [fr, dfr] = fdf(x);
    const f = sgn * fr;
    const df = sgn * dfr;
    if (!Number.isFinite(f)) throw new Error('solveMonotone: non-finite residual');
    if (Math.abs(f) <= tol * Math.max(1, Math.abs(scale))) return x;
    if (f < 0) lo = Number.isNaN(lo) ? x : Math.max(lo, x);
    else hi = Number.isNaN(hi) ? x : Math.min(hi, x);
    let xn = df > 0 ? x - f / df : Number.NaN;
    const bracketed = !Number.isNaN(lo) && !Number.isNaN(hi);
    if (bracketed) {
      if (!(xn > lo && xn < hi) || !Number.isFinite(xn)) xn = 0.5 * (lo + hi);
      if (Math.abs(hi - lo) <= 1e-14 * Math.max(1, Math.abs(x)) + 1e-300) return 0.5 * (lo + hi);
    } else if (!Number.isFinite(xn)) {
      const step = Math.max(Math.abs(x), Math.abs(scale), 1e-12);
      xn = f < 0 ? x + step : x - step;
    } else {
      // limit unbracketed Newton steps to avoid wild jumps
      const maxStep = 10 * Math.max(Math.abs(x), Math.abs(scale), 1e-12);
      if (Math.abs(xn - x) > maxStep) xn = x + Math.sign(xn - x) * maxStep;
    }
    if (Math.abs(xn - x) <= 1e-15 * Math.max(1, Math.abs(x))) return xn;
    x = xn;
  }
  if (!Number.isNaN(lo) && !Number.isNaN(hi)) return 0.5 * (lo + hi);
  throw new Error('solveMonotone: did not converge');
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
