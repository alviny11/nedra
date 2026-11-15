import { describe, expect, it } from 'vitest';
import { data, getRows, rowKey } from './data';
import { sortSegmentRows, type SegmentSort } from './segment-sort';
import { applyForecast, basisLabel } from './thickness-forecast';

const textOrder = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

function main2() {
  const group = data.groups.find(item => item.id === 'MAIN-2')!;
  const rows = getRows(group, data.forecastDate).map(row => applyForecast(row));
  const assetIndex = new Map(group.assets.map((asset, index) => [asset.id, index]));
  return { rows, assetIndex };
}

function keepsRelativeOrder(original: readonly { key: string; bucket: string }[], sorted: readonly { key: string; bucket: string }[]) {
  const expected = new Map<string, string[]>();
  for (const row of original) {
    const list = expected.get(row.bucket) ?? [];
    list.push(row.key);
    expected.set(row.bucket, list);
  }
  const seen = new Map<string, number>();
  for (const row of sorted) {
    const index = seen.get(row.bucket) ?? 0;
    expect(row.key).toBe(expected.get(row.bucket)?.[index]);
    seen.set(row.bucket, index + 1);
  }
}

describe('pipe segment table sort', () => {
  it('keeps distance order as start ascending along the pipe', () => {
    const { rows, assetIndex } = main2();
    const sorted = sortSegmentRows(rows, 'distance', assetIndex);
    expect(sorted.map(rowKey)).toEqual(rows.map(rowKey));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!, next = sorted[i]!;
      const prevAt = (assetIndex.get(prev.asset.id) ?? 0) * 1e9 + prev.start;
      const nextAt = (assetIndex.get(next.asset.id) ?? 0) * 1e9 + next.start;
      expect(nextAt).toBeGreaterThanOrEqual(prevAt);
    }
  });

  it('sorts measurements and dates with empty values last, and numbers and dates in order', () => {
    const { rows, assetIndex } = main2();
    for (const sort of ['vtd', 'date'] as const) {
      const sorted = sortSegmentRows(rows, sort, assetIndex);
      const value = (row: (typeof rows)[number]) => sort === 'vtd' ? row.measured : row.measuredDate;
      const firstEmpty = sorted.findIndex(row => value(row) == null);
      expect(firstEmpty).toBeGreaterThan(0);
      expect(sorted.slice(0, firstEmpty).every(row => value(row) != null)).toBe(true);
      expect(sorted.slice(firstEmpty).every(row => value(row) == null)).toBe(true);
      const present = sorted.slice(0, firstEmpty).map(value);
      const ordered = [...present].sort((a, b) => a == null || b == null ? 0 : a < b ? -1 : a > b ? 1 : 0);
      expect(present).toEqual(ordered);
      expect(rowKey(sorted[0]!)).not.toBe(rowKey(rows[0]!));
    }
  });

  it('sorts the forecast numerically and leaves text columns in a stable readable order', () => {
    const { rows, assetIndex } = main2();
    const forecast = sortSegmentRows(rows, 'forecast', assetIndex);
    const firstBlank = forecast.findIndex(row => !Number.isFinite(row.pred));
    const preds = forecast.slice(0, firstBlank).map(row => row.pred);
    expect(preds).toEqual([...preds].sort((a, b) => a - b));
    expect(forecast.slice(firstBlank).every(row => !Number.isFinite(row.pred))).toBe(true);
    expect(rowKey(forecast[0]!)).not.toBe(rowKey(rows[0]!));

    const checks: Array<[SegmentSort, (row: (typeof rows)[number]) => string]> = [
      ['segment', row => `${row.asset.id} / ${row.sid}`],
      ['basis', row => basisLabel(row)]
    ];
    for (const [sort, label] of checks) {
      const sorted = sortSegmentRows(rows, sort, assetIndex);
      for (let i = 1; i < sorted.length; i++) expect(textOrder.compare(label(sorted[i - 1]!), label(sorted[i]!))).toBeLessThanOrEqual(0);
      keepsRelativeOrder(rows.map(row => ({ key: rowKey(row), bucket: label(row) })), sorted.map(row => ({ key: rowKey(row), bucket: label(row) })));
    }
  });

  it('sorts only the rows it is given, so a search or filter stays in effect', () => {
    const { rows, assetIndex } = main2();
    const matched = rows.filter(row => String(row.asset.id) === '1250009490');
    const sorted = sortSegmentRows(matched, 'vtd', assetIndex);
    expect(sorted.map(row => row.asset.id)).toEqual(matched.map(() => 1250009490));
    expect(sorted.map(row => row.sid)).not.toEqual(matched.map(row => row.sid));
    expect(sorted.map(row => row.measured)).toEqual([...matched.map(row => row.measured)].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });
});
