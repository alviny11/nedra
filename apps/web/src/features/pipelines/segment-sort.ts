import type { Row } from './data';

/** Column order for the pipe segment table. `distance` is the order the rows already have. */
export type SegmentSort = 'segment' | 'distance' | 'vtd' | 'date' | 'forecast';

const textOrder = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

function missingLast(a: number | string | null, b: number | string | null): number {
  const emptyA = a == null || a === '';
  const emptyB = b == null || b === '';
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1;
  if (emptyB) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

export function compareSegmentRows(a: Row, b: Row, sort: SegmentSort, assetIndex: ReadonlyMap<number, number>): number {
  switch (sort) {
    case 'distance':
      return (assetIndex.get(a.asset.id) ?? 0) - (assetIndex.get(b.asset.id) ?? 0) || a.start - b.start || a.sid - b.sid;
    case 'segment':
      return textOrder.compare(`${a.asset.id} / ${a.sid}`, `${b.asset.id} / ${b.sid}`);
    case 'vtd':
      return missingLast(a.measured, b.measured);
    case 'date':
      return missingLast(a.measuredDate, b.measuredDate);
    case 'forecast':
      return missingLast(Number.isFinite(a.pred) ? a.pred : null, Number.isFinite(b.pred) ? b.pred : null);
  }
}

/** Stable sort. Equal keys keep the incoming order, which is distance along the pipe. */
export function sortSegmentRows(rows: readonly Row[], sort: SegmentSort, assetIndex: ReadonlyMap<number, number>): Row[] {
  return [...rows].sort((a, b) => compareSegmentRows(a, b, sort, assetIndex));
}
