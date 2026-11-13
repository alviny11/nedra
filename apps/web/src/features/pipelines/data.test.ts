import { describe, expect, it } from 'vitest';
import { data, getRows, rowKey, routePaths } from './data';

describe('Real pipeline snapshot', () => {
  it('covers the complete segment grid without duplicate keys', () => {
    const rows = data.groups.flatMap(g => getRows(g, data.forecastDate));
    expect(rows).toHaveLength(4668);
    expect(new Set(rows.map(rowKey)).size).toBe(rows.length);
    expect(rows.every(r => Number.isFinite(r.pred) && r.pred >= 0)).toBe(true);
    for (const g of data.groups) for (const a of g.assets) expect(a.segments).toHaveLength(Math.ceil(a.length/10));
  });
  it('never shows future observations at a historical cutoff', () => {
    for (const g of data.groups) {
      const rows = getRows(g, '2018-09-23');
      expect(rows.every(r => r.measuredDate == null || r.measuredDate <= '2018-09-23')).toBe(true);
      expect(getRows(g, '1900-01-01').every(r => r.measured == null)).toBe(true);
    }
  });
  it('does not invent measurements for the pipe without VTD', () => {
    const g = data.groups.find(g => g.id === 'MAIN-4')!;
    expect(getRows(g, data.forecastDate).every(r => r.measured == null && r.source === 'nominal_assumption')).toBe(true);
    expect(routePaths(g).every(p => p.startsWith('M') && !p.includes('NaN'))).toBe(true);
  });
});
