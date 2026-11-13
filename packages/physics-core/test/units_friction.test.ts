import { describe, expect, it } from 'vitest';
import {
  barToPa,
  paToBar,
  celsiusToKelvin,
  kelvinToCelsius,
  gaugeToAbsolute,
  absoluteToGauge,
  kinematicToDynamicViscosity,
  dynamicToKinematicViscosity,
  massToVolumeFlow,
  volumeToMassFlow,
  m3hToM3s,
  m3sToM3h,
  m3sToM3d,
  fanningToDarcy,
  colebrookFactor,
  haalandFactor,
  churchillFactor,
  frictionFactor,
  frictionTimesSpeed,
  P_ATM
} from '../src';

/** independent Colebrook solution by bisection on f (not the Newton implementation under test) */
function colebrookBisect(re: number, rr: number): number {
  let lo = 0.003;
  let hi = 0.3;
  for (let i = 0; i < 200; i++) {
    const f = 0.5 * (lo + hi);
    const g = 1 / Math.sqrt(f) + 2 * Math.log10(rr / 3.7 + 2.51 / (re * Math.sqrt(f)));
    if (g > 0) lo = f;
    else hi = f;
  }
  return 0.5 * (lo + hi);
}

describe('units', () => {
  it('round-trips conversions', () => {
    expect(barToPa(1)).toBe(1e5);
    expect(paToBar(250000)).toBeCloseTo(2.5, 12);
    expect(celsiusToKelvin(20)).toBeCloseTo(293.15, 12);
    expect(kelvinToCelsius(273.15)).toBeCloseTo(0, 12);
    expect(gaugeToAbsolute(0)).toBe(P_ATM);
    expect(absoluteToGauge(gaugeToAbsolute(123456))).toBeCloseTo(123456, 9);
    expect(kinematicToDynamicViscosity(1e-6, 1000)).toBeCloseTo(1e-3, 15);
    expect(dynamicToKinematicViscosity(0.02, 850)).toBeCloseTo(0.02 / 850, 15);
    expect(volumeToMassFlow(massToVolumeFlow(70, 850), 850)).toBeCloseTo(70, 12);
    expect(m3sToM3h(m3hToM3s(300))).toBeCloseTo(300, 9);
    expect(m3sToM3d(1)).toBe(86400);
    expect(fanningToDarcy(0.005)).toBeCloseTo(0.02, 15);
  });
});

describe('friction factor', () => {
  it('Colebrook (Newton) matches an independent bisection solution', () => {
    for (const re of [4e3, 1e4, 1e5, 1e6, 1e7]) {
      for (const rr of [0, 1e-5, 1e-4, 1e-3, 1e-2]) {
        const f = colebrookFactor(re, rr);
        expect(Math.abs(f / colebrookBisect(re, rr) - 1)).toBeLessThan(1e-9);
      }
    }
  });

  it('Haaland stays within 2% of Colebrook in the turbulent range', () => {
    let maxRel = 0;
    for (let lre = Math.log10(4e3); lre <= 8; lre += 0.1) {
      for (const rr of [0, 1e-6, 1e-5, 1e-4, 1e-3, 5e-3, 1e-2, 3e-2]) {
        const re = 10 ** lre;
        maxRel = Math.max(maxRel, Math.abs(haalandFactor(re, rr) / colebrookFactor(re, rr) - 1));
      }
    }
    expect(maxRel).toBeLessThan(0.02);
  });

  it('is exactly laminar 64/Re below Re=2000', () => {
    for (const re of [1, 10, 500, 1999.9]) expect(frictionFactor(re, 1e-4)).toBeCloseTo(64 / re, 14);
  });

  it('has no jumps across the transition region (continuous, small steps)', () => {
    for (const rr of [0, 1e-4, 1e-3]) {
      let prev = frictionFactor(1990, rr);
      let maxStep = 0;
      for (let re = 1991; re <= 4100; re += 1) {
        const f = frictionFactor(re, rr);
        maxStep = Math.max(maxStep, Math.abs(f / prev - 1));
        prev = f;
      }
      expect(maxStep).toBeLessThan(2e-3);
      expect(frictionFactor(2000 + 1e-9, rr)).toBeCloseTo(64 / 2000, 9);
      expect(frictionFactor(4000 - 1e-9, rr)).toBeCloseTo(colebrookFactor(4000, rr), 9);
    }
  });

  it('Churchill agrees with laminar and Colebrook limits', () => {
    expect(Math.abs(churchillFactor(500, 1e-4) / (64 / 500) - 1)).toBeLessThan(0.01);
    for (const re of [1e4, 1e5, 1e6]) expect(Math.abs(churchillFactor(re, 1e-4) / colebrookFactor(re, 1e-4) - 1)).toBeLessThan(0.03);
  });

  it('uses the analytic laminar limit at u = 0 (no 64/0)', () => {
    const v = frictionTimesSpeed(0, 0.2, 1e-6, 1e-4, 'colebrook');
    expect(v).toBeCloseTo((64 * 1e-6) / 0.2, 15);
    expect(Number.isFinite(v)).toBe(true);
  });

  it('friction always opposes velocity', () => {
    for (const u of [-2, -0.01, 0.01, 2]) {
      const fU = frictionTimesSpeed(u, 0.2, 1e-6, 1e-4, 'colebrook');
      const source = -(fU * u) / (2 * 0.2); // du/dt contribution
      expect(Math.sign(source)).toBe(-Math.sign(u));
    }
  });
});
