/** Unit conversions. The core works in SI only; these helpers exist for UI and tests. */

export const G = 9.80665; // m/s2
export const P_ATM = 101325; // Pa
export const ZERO_C_K = 273.15;

export const barToPa = (bar: number): number => bar * 1e5;
export const paToBar = (pa: number): number => pa / 1e5;
export const celsiusToKelvin = (c: number): number => c + ZERO_C_K;
export const kelvinToCelsius = (k: number): number => k - ZERO_C_K;
export const gaugeToAbsolute = (gaugePa: number, atmPa: number = P_ATM): number => gaugePa + atmPa;
export const absoluteToGauge = (absPa: number, atmPa: number = P_ATM): number => absPa - atmPa;
export const kinematicToDynamicViscosity = (nuM2S: number, rhoKgM3: number): number => nuM2S * rhoKgM3;
export const dynamicToKinematicViscosity = (muPaS: number, rhoKgM3: number): number => muPaS / rhoKgM3;
export const massToVolumeFlow = (mKgS: number, rhoKgM3: number): number => mKgS / rhoKgM3;
export const volumeToMassFlow = (qM3S: number, rhoKgM3: number): number => qM3S * rhoKgM3;
export const m3sToM3h = (q: number): number => q * 3600;
export const m3hToM3s = (q: number): number => q / 3600;
export const m3sToM3d = (q: number): number => q * 86400;
export const m3dToM3s = (q: number): number => q / 86400;
export const mPaSToPaS = (mpas: number): number => mpas * 1e-3;
export const cStToM2S = (cst: number): number => cst * 1e-6;
export const circleArea = (d: number): number => (Math.PI * d * d) / 4;
/** Darcy friction factor from Fanning */
export const fanningToDarcy = (fF: number): number => 4 * fF;
