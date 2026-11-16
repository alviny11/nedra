import { describe, expect, it } from 'vitest';
import { data, getRows } from './data';
import { getViewRows, segmentHistory } from './pipeline-view';
import { applyForecast, bundledForecast, CASE1_PIPE, CASE2_PIPE, isScored, PIPE_FORECAST } from './thickness-forecast';

const main2 = data.groups.find(g => g.id === 'MAIN-2')!;

describe('Historical pipeline view', () => {
  it('hides every prediction and priority candidate, including old snapshot values', () => {
    const before = JSON.stringify(main2);
    const rows = getViewRows(main2, '2018-09-23', false);
    expect(rows).toHaveLength(getRows(main2, '2018-09-23').length);
    expect(rows.every(r => Number.isNaN(r.pred) && !isScored(r))).toBe(true);
    expect(rows.some(r => r.measured != null)).toBe(true);
    for (const row of rows) {
      expect(row.measuredDate == null || row.measuredDate <= '2018-09-23').toBe(true);
      expect(segmentHistory(row, '2018-09-23').every(h => h[1] <= '2018-09-23')).toBe(true);
    }
    expect(JSON.stringify(main2)).toBe(before);
  });

  it('filters later history and distinguishes forecast from inspection on the same date', () => {
    const row = getRows(main2, data.forecastDate).find(r => r.asset.id === CASE1_PIPE && r.asset.history.some(h => h[0] === r.sid && h[1] > '2018-09-23'))!;
    expect(row).toBeDefined();
    expect(segmentHistory(row, '2018-09-23').length).toBeLessThan(segmentHistory(row, data.forecastDate).length);
    expect(getViewRows(main2, '2023-12-01', false).every(r => Number.isNaN(r.pred))).toBe(true);
    expect(getViewRows(main2, '2023-12-01', true).filter(isScored)).toHaveLength(525);
    expect(getViewRows(main2, '2023-11-30', true).filter(isScored)).toHaveLength(0);
  });

  it('restores the unchanged predictions of both cases and preserves the complete export', () => {
    const csv = bundledForecast.csv;
    for (const [id, count] of [[CASE1_PIPE, 525], [CASE2_PIPE, 1475]]) {
      const group = data.groups.find(g => g.assets.some(a => a.id === id))!;
      const date = PIPE_FORECAST[id!]!.date;
      getViewRows(group, '2018-09-23', false);
      const rows = getViewRows(group, date, true);
      expect(rows.filter(isScored)).toHaveLength(count!);
      const expected = getRows(group, date).map(r => applyForecast(r));
      expect(rows.map(r => r.pred)).toEqual(expected.map(r => r.pred));
      expect(rows.every(r => r.measuredDate == null || r.measuredDate <= date)).toBe(true);
    }
    expect(bundledForecast.csv).toBe(csv);
    expect(csv.trim().split('\n')).toHaveLength(2001);
  });
});
