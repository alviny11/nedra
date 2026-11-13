import { describe, expect, it } from 'vitest';
import { barA, barG, closestFraction, degC, fmtTime, m3h, pointAlong, sensorValueText } from './format';

describe('display conversions (UI only, core stays SI)', () => {
  it('converts units for display', () => {
    expect(barA(4.2e5)).toBe('4.20');
    expect(barG(101325 + 1e5)).toBe('1.00');
    expect(degC(323.15)).toBe('50.0');
    expect(m3h(0.0833333)).toBe('300.0');
    expect(sensorValueText('pressure', null)).toBe('нет данных');
    expect(sensorValueText('waterFraction', 0.2)).toBe('20.0 % (об.)');
  });
  it('formats simulation time without 60.0 s artefacts', () => {
    expect(fmtTime(59.96)).toBe('01:00.0');
    expect(fmtTime(0)).toBe('00:00.0');
    expect(fmtTime(899.94)).toBe('14:59.9');
  });
  it('maps physical fraction to the drawing polyline and back (drawing does not define physical length)', () => {
    const poly = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 }
    ];
    const p = pointAlong(poly, 0.75);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(50);
    expect(closestFraction(poly, 100, 50).f).toBeCloseTo(0.75);
  });
});
