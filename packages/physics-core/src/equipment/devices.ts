import type { PumpConfig, ValveConfig } from '@pipetwin/contracts';
import { G } from '../units';
import { interpLinear } from '../numerics/interp';

/**
 * Pump head curve: least-squares quadratic H_ref(Q) = h0 + h1 Q + h2 Q^2 through the table.
 * Similarity with s = n/n_ref: H(Q, s) = s^2 H_ref(Q/s) = h0 s^2 + h1 s Q + h2 Q|Q|.
 * The product form has no division, so s = 0 is a regular branch (stopped impeller = resistance).
 */
export interface PumpCurve {
  h0: number;
  h1: number;
  h2: number;
}

export function fitPumpCurve(cfg: PumpConfig): PumpCurve {
  const q = cfg.curve.flowM3S;
  const h = cfg.curve.headM;
  // normal equations for [1, q, q^2]
  const S = [0, 0, 0, 0, 0];
  const T = [0, 0, 0];
  for (let i = 0; i < q.length; i++) {
    const x = q[i]!;
    let xp = 1;
    for (let k = 0; k < 5; k++) {
      S[k]! += xp;
      xp *= x;
    }
    T[0]! += h[i]!;
    T[1]! += h[i]! * x;
    T[2]! += h[i]! * x * x;
  }
  const M = [
    [S[0]!, S[1]!, S[2]!],
    [S[1]!, S[2]!, S[3]!],
    [S[2]!, S[3]!, S[4]!]
  ];
  const sol = solve3(M, T);
  return { h0: sol[0]!, h1: sol[1]!, h2: sol[2]! };
}

function solve3(M: number[][], b: number[]): number[] {
  const a = M.map((r) => r.slice());
  const x = b.slice();
  for (let k = 0; k < 3; k++) {
    let p = k;
    for (let i = k + 1; i < 3; i++) if (Math.abs(a[i]![k]!) > Math.abs(a[p]![k]!)) p = i;
    [a[k], a[p]] = [a[p]!, a[k]!];
    [x[k], x[p]] = [x[p]!, x[k]!];
    for (let i = k + 1; i < 3; i++) {
      const f = a[i]![k]! / a[k]![k]!;
      for (let j = k; j < 3; j++) a[i]![j]! -= f * a[k]![j]!;
      x[i]! -= f * x[k]!;
    }
  }
  for (let i = 2; i >= 0; i--) {
    let s = x[i]!;
    for (let j = i + 1; j < 3; j++) s -= a[i]![j]! * x[j]!;
    x[i] = s / a[i]![i]!;
  }
  return x;
}

export function pumpHead(curve: PumpCurve, qM3S: number, speedRatio: number): number {
  return curve.h0 * speedRatio * speedRatio + curve.h1 * speedRatio * qM3S + curve.h2 * qM3S * Math.abs(qM3S);
}

export function pumpHeadDerivative(curve: PumpCurve, qM3S: number, speedRatio: number): number {
  return curve.h1 * speedRatio + 2 * curve.h2 * Math.abs(qM3S);
}

export function pumpPressureRise(curve: PumpCurve, rho: number, qM3S: number, speedRatio: number): number {
  return rho * G * pumpHead(curve, qM3S, speedRatio);
}

/** Hydraulic and shaft power, only meaningful when an efficiency curve is given. */
export function pumpPower(cfg: PumpConfig, dpPa: number, qM3S: number, speedRatio: number): { hydraulicW: number; shaftW?: number } {
  const hydraulicW = dpPa * qM3S;
  if (!cfg.efficiency || speedRatio <= 0) return { hydraulicW };
  const eta = interpLinear(cfg.efficiency.flowM3S, cfg.efficiency.eta, qM3S / speedRatio);
  if (!(eta > 0.05)) return { hydraulicW };
  return { hydraulicW, shaftW: hydraulicW / eta };
}

/**
 * Valve loss coefficient K(theta) referred to the bore area. Log-linear interpolation of the table.
 * Below the first tabulated opening the valve is modelled explicitly as an orifice with K ~ 1/theta^2
 * (documented asymptote); theta <= 0 means fully closed (handled as Q = 0 by the solvers).
 */
export function valveLossCoefficient(cfg: ValveConfig, opening: number): number {
  if (opening <= 0) return Number.POSITIVE_INFINITY;
  const th = cfg.characteristic.opening;
  const k = cfg.characteristic.lossCoefficientK;
  if (opening <= th[0]!) return k[0]! * Math.pow(th[0]! / opening, 2);
  if (opening >= th[th.length - 1]!) return k[k.length - 1]!;
  let lo = 0;
  let hi = th.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (th[mid]! <= opening) lo = mid;
    else hi = mid;
  }
  const t = (opening - th[lo]!) / (th[hi]! - th[lo]!);
  return Math.exp(Math.log(k[lo]!) + t * (Math.log(k[hi]!) - Math.log(k[lo]!)));
}

/** first-order actuator, exact over dt */
export function firstOrderActuator(current: number, command: number, dt: number, tau: number): number {
  if (tau <= 0) return command;
  return command + (current - command) * Math.exp(-dt / tau);
}

/** rate-limited valve stroke (full stroke time T) */
export function rateLimitedStroke(current: number, command: number, dt: number, strokeTimeS: number): number {
  if (strokeTimeS <= 0) return command;
  const maxDelta = dt / strokeTimeS;
  const d = command - current;
  if (Math.abs(d) <= maxDelta) return command;
  return current + Math.sign(d) * maxDelta;
}
