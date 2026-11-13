import { describe, expect, it } from 'vitest';
import { data } from './data';
import { addDays, daysBetween, holeDistanceM, initialClock, LIVE_PIPELINE_ID, PASSPORT_REJECT_FIELD, runUntilScrap, stepDay, thinnestRateMmPerYear, YEAR_DAYS } from './corrosion-clock';

const group = data.groups.find((item) => item.id === LIVE_PIPELINE_ID)!;

describe('Daily corrosion clock on the live pipe', () => {
  it('uses the thinnest forecast rate, not the passport corrosion rate', () => {
    const rate = thinnestRateMmPerYear(group, data.forecastDate);
    expect(rate).toBeGreaterThan(0.02);
    expect(rate).toBeLessThan(0.03);
    expect(rate).toBeLessThan(0.72);
  });

  it('steps one calendar day and does not apply a x30 multiplier', () => {
    let clock = initialClock(group, data.forecastDate);
    const start = clock.date;
    const rate = clock.rateMmYear;
    for (let i = 0; i < 30; i++) clock = stepDay(clock);
    expect(clock.daysStepped).toBe(30);
    expect(daysBetween(start, clock.date)).toBe(30);
    const wall = clock.walls.find((item) => item.origin === start)!;
    const oneMonth = 30 * (rate / YEAR_DAYS);
    expect(wall.thicknessMm).toBeCloseTo(wall.baseMm - oneMonth, 8);
    expect(wall.thicknessMm).not.toBeCloseTo(wall.baseMm - 30 * oneMonth, 6);
  });

  it('stops on the passport scrap thickness of the thinnest measured wall', () => {
    const breach = runUntilScrap(group, data.forecastDate);
    expect(PASSPORT_REJECT_FIELD).toContain('отбраковочная');
    expect(breach.date).toBe('2067-12-02');
    expect(breach.assetId).toBe(1250022871);
    expect(breach.sid).toBe(135);
    expect(breach.origin).toBe('2022-07-06');
    expect(breach.baseMm).toBe(3.52);
    expect(breach.source).toBe('observed_defect_minimum');
    expect(breach.rejectMm).toBe(2.5);
    expect(breach.thicknessMm).toBeLessThanOrEqual(2.5);
    expect(breach.thicknessMm).toBeGreaterThan(2.5 - breach.dailyMm - 1e-9);
    expect(breach.thicknessMm).toBeGreaterThan(1);
    expect(addDays(breach.origin, breach.thinningDays)).toBe(breach.date);
    let thickness = breach.baseMm;
    let days = 0;
    while (thickness > breach.rejectMm) {
      thickness -= breach.dailyMm;
      days += 1;
    }
    expect(days).toBe(breach.thinningDays);
    expect(thickness).toBeCloseTo(breach.thicknessMm, 8);
    const distance = holeDistanceM(breach.chainageM, group.length, 2800);
    expect(distance).toBeGreaterThan(1);
    expect(distance).toBeLessThan(2799);
  });
});
