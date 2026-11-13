import { ModelDomainError } from '@pipetwin/contracts';

/** Piecewise-linear interpolation of a monotone abscissa table; clamps only when allowed. */
export function interpLinear(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (n === 0) throw new Error('interpLinear: empty table');
  if (n === 1 || x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - xs[lo]!) / (xs[hi]! - xs[lo]!);
  return ys[lo]! + t * (ys[hi]! - ys[lo]!);
}

/** Positive log-interpolation of tabulated points. Outside the table -> PROFILE_OUT_OF_RANGE. */
export function interpLogStrict(xs: readonly number[], ys: readonly number[], x: number, what: string): number {
  const n = xs.length;
  const eps = 1e-9 * Math.max(1, Math.abs(x));
  if (x < xs[0]! - eps || x > xs[n - 1]! + eps) {
    throw new ModelDomainError('PROFILE_OUT_OF_RANGE', `${what}: ${x} outside table [${xs[0]}, ${xs[n - 1]}]`, {
      value: x,
      min: xs[0],
      max: xs[n - 1]
    });
  }
  const lx = Math.min(Math.max(x, xs[0]!), xs[n - 1]!);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= lx) lo = mid;
    else hi = mid;
  }
  if (n === 1) return ys[0]!;
  const t = (lx - xs[lo]!) / (xs[hi]! - xs[lo]!);
  return Math.exp(Math.log(ys[lo]!) + t * (Math.log(ys[hi]!) - Math.log(ys[lo]!)));
}

/** Evaluate a piecewise-linear elevation profile at distance x (clamped to the profile ends). */
export function profileAt(points: ReadonlyArray<{ distanceM: number; elevationM: number }>, x: number): number {
  const xs = points.map((p) => p.distanceM);
  const ys = points.map((p) => p.elevationM);
  return interpLinear(xs, ys, x);
}

/** smoothstep 3s^2 - 2s^3 on [0,1] */
export function smoothstep01(s: number): number {
  if (s <= 0) return 0;
  if (s >= 1) return 1;
  return s * s * (3 - 2 * s);
}

/** Ramp helper: value moving from a to b over [t0, t0+dur] with smoothstep; dur=0 -> step. */
export function smoothRamp(t: number, t0: number, dur: number, a: number, b: number): number {
  if (t < t0) return a;
  if (dur <= 0) return b;
  return a + (b - a) * smoothstep01((t - t0) / dur);
}
