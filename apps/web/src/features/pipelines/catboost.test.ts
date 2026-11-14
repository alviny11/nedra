import { describe, expect, it } from 'vitest';
import { applyCatboost, bundledCatboost, parseCatboostCsv } from './catboost';
import { data, getRows, rowKey } from './data';

describe('CatBoost result overlay', () => {
  it('parses the bundled result.csv from the model run', () => {
    expect(bundledCatboost.byKey.size).toBe(147);
    expect(bundledCatboost.csv.startsWith('id,segment_id,thickness_pred\n1250009490,0,5.634172484001331\n')).toBe(true);
    expect(parseCatboostCsv(bundledCatboost.csv).get('1250009490:0')).toBe(5.634172484001331);
  });

  it('scores 53 segments on MAIN-2 and leaves the snapshot thickness untouched', () => {
    const main2 = data.groups.find(g => g.id === 'MAIN-2')!;
    const rows = getRows(main2, data.forecastDate);
    const first = rows[0]!;
    expect(rowKey(first)).toBe('1250009490:0');
    expect(first.pred).toBe(4.92792);
    expect(first.source).toBe('observed_defect_minimum');
    const shown = applyCatboost(first, bundledCatboost);
    expect(shown.pred).toBe(5.634172484001331);
    expect(shown.source).toBe('catboost');
    expect(first.pred).toBe(4.92792);
    expect(first.source).toBe('observed_defect_minimum');
    expect(rows.filter(r => applyCatboost(r, bundledCatboost).source === 'catboost')).toHaveLength(53);
    const main4 = data.groups.find(g => g.id === 'MAIN-4')!;
    expect(getRows(main4, data.forecastDate).every(r => applyCatboost(r, bundledCatboost).source === 'no_catboost')).toBe(true);
  });
});
