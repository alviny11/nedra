/**
 * Darcy friction factor f_D (f_D = 4 f_Fanning).
 *  - laminar Re <= 2000: f = 64/Re (exact Hagen-Poiseuille)
 *  - turbulent Re >= 4000: Colebrook-White (solved by Newton) or Haaland (explicit approximation)
 *  - 2000 < Re < 4000: cubic Hermite interpolation in Re between the laminar and turbulent
 *    end points with matched slopes (C1, no jumps). No universal accuracy is claimed there.
 */

export type FrictionModel = 'colebrook' | 'haaland';

export const RE_LAMINAR_MAX = 2000;
export const RE_TURBULENT_MIN = 4000;
const LN10 = Math.LN10;

export function haalandFactor(re: number, relRoughness: number): number {
  const t = Math.pow(relRoughness / 3.7, 1.11) + 6.9 / re;
  const y = -1.8 * Math.log10(t);
  return 1 / (y * y);
}

/** Colebrook-White solved for y = 1/sqrt(f) with Newton iterations started from Haaland. */
export function colebrookFactor(re: number, relRoughness: number): number {
  let y = 1 / Math.sqrt(haalandFactor(re, relRoughness));
  const a = relRoughness / 3.7;
  const b = 2.51 / re;
  for (let it = 0; it < 20; it++) {
    const arg = a + b * y;
    const F = y + 2 * Math.log10(arg);
    const dF = 1 + (2 / LN10) * (b / arg);
    const dy = F / dF;
    y -= dy;
    if (Math.abs(dy) < 1e-13 * y) break;
  }
  return 1 / (y * y);
}

export function turbulentFactor(re: number, relRoughness: number, model: FrictionModel): number {
  return model === 'haaland' ? haalandFactor(re, relRoughness) : colebrookFactor(re, relRoughness);
}

/** Churchill (1977) all-regime correlation, provided for comparison tests only. */
export function churchillFactor(re: number, relRoughness: number): number {
  const A = Math.pow(2.457 * Math.log(1 / (Math.pow(7 / re, 0.9) + 0.27 * relRoughness)), 16);
  const B = Math.pow(37530 / re, 16);
  return 8 * Math.pow(Math.pow(8 / re, 12) + Math.pow(A + B, -1.5), 1 / 12);
}

export function frictionFactor(re: number, relRoughness: number, model: FrictionModel = 'colebrook'): number {
  if (!(re > 0)) throw new Error('frictionFactor requires Re > 0; use frictionTimesSpeed for u = 0');
  if (re <= RE_LAMINAR_MAX) return 64 / re;
  if (re >= RE_TURBULENT_MIN) return turbulentFactor(re, relRoughness, model);
  // Hermite blend
  const r0 = RE_LAMINAR_MAX;
  const r1 = RE_TURBULENT_MIN;
  const f0 = 64 / r0;
  const d0 = -64 / (r0 * r0);
  const f1 = turbulentFactor(r1, relRoughness, model);
  const h = 1e-3 * r1;
  const d1 = (turbulentFactor(r1 + h, relRoughness, model) - turbulentFactor(r1 - h, relRoughness, model)) / (2 * h);
  const w = r1 - r0;
  const s = (re - r0) / w;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  return h00 * f0 + h10 * w * d0 + h01 * f1 + h11 * w * d1;
}

/**
 * Returns f_D * |u| [m/s], the quantity entering the momentum source f u|u|/(2D).
 * For Re <= 2000 the exact laminar limit 64 nu / D is returned (finite at u = 0).
 */
export function frictionTimesSpeed(
  u: number,
  diameterM: number,
  kinematicViscosityM2S: number,
  relRoughness: number,
  model: FrictionModel
): number {
  const au = Math.abs(u);
  const re = (au * diameterM) / kinematicViscosityM2S;
  if (re <= RE_LAMINAR_MAX) return (64 * kinematicViscosityM2S) / diameterM;
  return frictionFactor(re, relRoughness, model) * au;
}

/**
 * Frictional pressure gradient magnitude-with-sign dp/dx = -G(u); returns G(u) = f rho u|u| / (2D) [Pa/m].
 */
export function frictionGradient(
  u: number,
  diameterM: number,
  rho: number,
  mu: number,
  relRoughness: number,
  model: FrictionModel
): number {
  return (frictionTimesSpeed(u, diameterM, mu / rho, relRoughness, model) * rho * u) / (2 * diameterM);
}
