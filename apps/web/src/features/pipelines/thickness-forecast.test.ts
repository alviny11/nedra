import { describe, expect, it } from 'vitest';
import features from '../../../../../backend_bundle/data/predict_features.csv?raw';
import { data, fmt, getRows } from './data';
import { applyForecast, bundledForecast, CASE1_BASE_RUN, CASE1_LENGTH_M, CASE1_PIPE, CASE1_SHIFT_END_M, CASE1_SHIFT_START_M, CASE2_PIPE, case1OdometerShift, case1ShiftedBases, chartGreenWall, isScored } from './thickness-forecast';

function shown(pipeId: number) {
  const group = data.groups.find(item => item.assets.some(asset => asset.id === pipeId))!;
  return getRows(group, data.forecastDate).filter(row => row.asset.id === pipeId).map(row => applyForecast(row));
}

function stats(values: number[]) {
  return { min: Math.min(...values), mean: values.reduce((sum, value) => sum + value, 0) / values.length, max: Math.max(...values) };
}

describe('Current thickness forecast on the pipe card', () => {
  it('reads result.csv for the two pipes and leaves every other section blank', () => {
    expect(bundledForecast.csv.startsWith('id,segment_id,thickness_pred\n1250022871,0,5.926620\n')).toBe(true);
    expect(bundledForecast.byKey.size).toBe(2000);
    const case1 = shown(CASE1_PIPE);
    const case2 = shown(CASE2_PIPE);
    expect(case1.every(isScored)).toBe(true);
    expect(case2.every(row => row.source === 'elevation')).toBe(true);
    expect(case1[0]?.pred).toBe(5.92662);
    expect(case1.find(row => row.sid === 135)?.pred).toBe(3.394037);
    expect(case2[0]?.pred).toBe(4.2615);
    const main2 = data.groups.find(item => item.id === 'MAIN-2')!;
    const untouched = getRows(main2, data.forecastDate)[0]!;
    expect(untouched.asset.id).toBe(1250009490);
    expect(untouched.pred).toBe(4.92792);
    const hidden = applyForecast(untouched);
    expect(hidden.pred).toBeNaN();
    expect(hidden.source).toBe('no_forecast');
    expect(untouched.pred).toBe(4.92792);
  });

  it('matches the min, mean and max the card draws for each pipe', () => {
    const forest = stats(shown(CASE1_PIPE).map(row => row.pred));
    const elevation = stats(shown(CASE2_PIPE).map(row => row.pred));
    expect(forest.min).toBe(3.394037);
    expect(forest.max).toBe(6.708687);
    expect(forest.mean).toBeCloseTo(5.900046830476191, 12);
    expect(elevation.min).toBe(3.042);
    expect(elevation.max).toBe(4.427);
    expect(elevation.mean).toBeCloseTo(3.569143525423729, 12);
    expect(fmt(forest.min)).toBe('3,39');
    expect(fmt(forest.mean)).toBe('5,9');
    expect(fmt(forest.max)).toBe('6,71');
    expect(fmt(elevation.min)).toBe('3,04');
    expect(fmt(elevation.mean)).toBe('3,57');
    expect(fmt(elevation.max)).toBe('4,43');
  });
});

describe('Case 1 odometer shift on the pipe-length chart', () => {
  it('uses the ramp baked into the forecast base', () => {
    expect(case1OdometerShift(0)).toBeCloseTo(CASE1_SHIFT_START_M, 8);
    expect(case1OdometerShift(CASE1_LENGTH_M)).toBeCloseTo(CASE1_SHIFT_END_M, 8);
    expect(case1OdometerShift(CASE1_LENGTH_M / 2)).toBeCloseTo((CASE1_SHIFT_START_M + CASE1_SHIFT_END_M) / 2, 8);
    const raw = 1354.93153;
    expect(Math.floor((raw + case1OdometerShift(raw)) / 10)).toBe(135);
  });

  it('keeps every green point on the orange segment centre and never draws it below the forecast', () => {
    const group = data.groups.find(item => item.assets.some(asset => asset.id === CASE1_PIPE))!;
    const asset = group.assets.find(item => item.id === CASE1_PIPE)!;
    const bases = case1ShiftedBases(asset.defects);
    const rows = shown(CASE1_PIPE);
    const y = (v: number, maxH: number) => 215 - v / maxH * 145;
    const maxH = Math.max(1, ...rows.map(row => Math.max(row.asset.nominal, chartGreenWall(row, bases) ?? 0, row.pred))) + 1;
    let pairs = 0;
    for (const row of rows) {
      const green = chartGreenWall(row, bases);
      expect(row.x).toBe(row.asset.offset + (row.start + row.end) / 2);
      if (green == null) continue;
      pairs += 1;
      expect(row.pred).toBeLessThanOrEqual(green);
      expect(y(green, maxH)).toBeLessThanOrEqual(y(row.pred, maxH));
    }
    expect(pairs).toBe(510);
    expect(bases.size).toBe(510);
    const earlier = getRows(group, '2018-09-23').filter(row => row.asset.id === CASE1_PIPE);
    expect(earlier.every(row => chartGreenWall(row, null) === row.measured)).toBe(true);
    const neighbor = getRows(group, data.forecastDate).find(row => row.asset.id === 1250009490 && row.measured != null)!;
    expect(chartGreenWall(neighbor, bases)).toBe(neighbor.measured);
    const otherPipe = getRows(data.groups.find(item => item.id === 'MAIN-4')!, data.forecastDate)[0]!;
    expect(otherPipe.asset.id).toBe(CASE2_PIPE);
    expect(chartGreenWall(otherPipe, bases)).toBe(otherPipe.measured);
  });

  it('lands the 2022 ILI in the same segments the case 1 base used', () => {
    const asset = data.groups.flatMap(group => group.assets).find(item => item.id === CASE1_PIPE)!;
    const mins = new Map<number, number>();
    for (const defect of asset.defects) {
      if (defect[1] !== CASE1_BASE_RUN) continue;
      const moved = defect[2] + case1OdometerShift(defect[2]);
      if (moved < 0 || moved >= asset.length) continue;
      const sid = Math.min(Math.floor(moved / 10), asset.segments.length - 1);
      const prev = mins.get(sid);
      if (prev == null || defect[3] < prev) mins.set(sid, defect[3]);
    }
    let observed = 0;
    let matched = 0;
    for (const line of features.split('\n')) {
      const cells = line.split(',');
      if (cells[1] !== String(CASE1_PIPE)) continue;
      const sid = Number(cells[2]);
      const missing = Number(cells[24]);
      if (missing !== 0) {
        expect(mins.has(sid)).toBe(false);
        continue;
      }
      observed += 1;
      const wall = mins.get(sid);
      if (wall != null && Math.abs(wall - Number(cells[23])) < 0.011) matched += 1;
    }
    expect(observed).toBe(510);
    expect(matched).toBe(510);
  });
});
