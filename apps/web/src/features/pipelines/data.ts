import snapshot from './real-data.json';

export interface Segment { sid: number; start: number; end: number; pred: number; base: number; source: string; lastDate: string | null; coverage: number }
export type History = [number, string, number, boolean];
export type Defect = [number, string, number, number, number | null, number | null, number | null, number | null, string];
export interface Asset {
  id: number; name: string; length: number; offset: number; diameter: number; nominal: number;
  commissioned: string; steel: string | null; warning: boolean; route: number[][]; profile: number[][];
  segments: Segment[]; history: History[]; defects: Defect[]; regime: Array<[string, number | null, number | null, number | null, number | null]>;
  uzt: Array<[number, string, number, number]>;
  chemistry: Array<{ date: string; sid: number; ph: number | null; co2: number | null; rate: number | null }>;
}
export interface Pipeline { id: string; title: string; length: number; featured: boolean; assets: Asset[] }
export const data = snapshot as unknown as { forecastDate: string; isDemoDate: boolean; model: string; groups: Pipeline[] };
export interface Row extends Segment { asset: Asset; x: number; measured: number | null; measuredDate: string | null }
export const fmt = (v: number | null | undefined, digits = 2): string => v == null || !Number.isFinite(v) ? 'Нет данных' : v.toLocaleString('ru-RU', { maximumFractionDigits: digits });
export const dateLabel = (date: string): string => date.slice(0, 10).split('-').reverse().join('.');
export const rowKey = (row: Row): string => `${row.asset.id}:${row.sid}`;

export function getRows(group: Pipeline, date: string): Row[] {
  return group.assets.flatMap(asset => {
    const latest = new Map<number, History>();
    for (const h of asset.history) if (h[1] <= date && (!latest.has(h[0]) || latest.get(h[0])![1] < h[1])) latest.set(h[0], h);
    return asset.segments.map(s => ({ ...s, asset, x: asset.offset + (s.start+s.end)/2,
      measured: latest.get(s.sid)?.[2] ?? null, measuredDate: latest.get(s.sid)?.[1] ?? null }));
  });
}

export function routePaths(group: Pipeline): string[] {
  const points = group.assets.flatMap(a => a.route);
  const xs = points.map(p => p[0]!), ys = points.map(p => p[1]!);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const dx = Math.max(...xs)-minX || 1, dy = Math.max(...ys)-minY || 1;
  const scale = Math.min(350/dx, 80/dy);
  return group.assets.map(a => a.route.map((p, i) => `${i ? 'L' : 'M'}${25+(p[0]!-minX)*scale},${110-(p[1]!-minY)*scale}`).join(' '));
}

