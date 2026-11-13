/**
 * Leak outflow laws.
 *  - liquid orifice (M0): m = Cd A_h sqrt(2 rho (p - p_ext)), only for p > p_ext
 *  - ideal-gas nozzle (reference formulas for the gas-limit tests / future M1 work)
 * The open AREA fraction s(t) follows smoothstep 3x^2-2x^3 over the opening duration.
 */
import { smoothstep01 } from '../numerics/interp';

export function holeArea(diameterM: number): number {
  return (Math.PI * diameterM * diameterM) / 4;
}

/** open area fraction (not diameter fraction) */
export function openAreaFraction(t: number, startTimeS: number, openingDurationS: number): number {
  if (t < startTimeS) return 0;
  if (openingDurationS <= 0) return 1;
  return smoothstep01((t - startTimeS) / openingDurationS);
}

export function liquidOrificeMassFlow(cd: number, areaM2: number, rho: number, p: number, pExt: number): number {
  if (p <= pExt) return 0;
  return cd * areaM2 * Math.sqrt(2 * rho * (p - pExt));
}

export function criticalPressureRatio(gamma: number): number {
  return Math.pow(2 / (gamma + 1), gamma / (gamma - 1));
}

/** Ideal-gas orifice mass flow with stagnation p0,T0; continuous at the critical ratio. */
export function idealGasOrificeMassFlow(
  cd: number,
  areaM2: number,
  p0: number,
  T0: number,
  pExt: number,
  gamma: number,
  rGas: number
): number {
  if (pExt >= p0) return 0;
  const r = pExt / p0;
  const rc = criticalPressureRatio(gamma);
  if (r <= rc) {
    return cd * areaM2 * p0 * Math.sqrt(gamma / (rGas * T0)) * Math.pow(2 / (gamma + 1), (gamma + 1) / (2 * (gamma - 1)));
  }
  const term = Math.pow(r, 2 / gamma) - Math.pow(r, (gamma + 1) / gamma);
  return cd * areaM2 * p0 * Math.sqrt(((2 * gamma) / (rGas * T0 * (gamma - 1))) * term);
}
