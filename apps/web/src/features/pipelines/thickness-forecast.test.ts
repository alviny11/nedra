import { describe, expect, it } from 'vitest';
import { data, fmt, getRows } from './data';
import { applyForecast, bundledForecast, CASE1_PIPE, CASE2_PIPE, isScored } from './thickness-forecast';

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
