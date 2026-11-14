import bundledCsv from '../../../../../models/cb-history-d6/result.csv?raw';
import type { Row } from './data';

export const CATBOOST_MODEL_ID = 'cb_history_d6_MAE';
export const CATBOOST_DATE = '2023-12-01';

export interface CatboostPack {
  csv: string;
  byKey: Map<string, number>;
  source: 'live' | 'saved';
}

export function parseCatboostCsv(csv: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const [id, sid, pred] = line.split(',');
    const value = Number(pred);
    if (id && sid != null && sid !== '' && Number.isFinite(value)) map.set(`${id}:${sid}`, value);
  }
  return map;
}

export function packFromCsv(csv: string, source: 'live' | 'saved'): CatboostPack | null {
  const trimmed = csv.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!trimmed.startsWith('id,segment_id,thickness_pred')) return null;
  const byKey = parseCatboostCsv(trimmed);
  if (!byKey.size) return null;
  return { csv: `${trimmed}\n`, byKey, source };
}

export const bundledCatboost: CatboostPack = packFromCsv(bundledCsv, 'saved') ?? { csv: 'id,segment_id,thickness_pred\n', byKey: new Map(), source: 'saved' };

/** Forecast column only. Does not write back into the snapshot used by the corrosion clock. */
export function applyCatboost(row: Row, pack: CatboostPack): Row {
  const pred = pack.byKey.get(`${row.asset.id}:${row.sid}`);
  if (pred == null) return { ...row, pred: Number.NaN, source: 'no_catboost' };
  return { ...row, pred, source: 'catboost' };
}

export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function readCsv(url: string, preferLive: boolean): Promise<CatboostPack | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const response = await fetch(url, { signal: ctl.signal, headers: { Accept: 'text/csv' } });
    if (!response.ok) return null;
    const csv = await response.text();
    const header = response.headers.get('X-Catboost-Source');
    const source = header === 'live' || (preferLive && header !== 'saved-run') ? 'live' : 'saved';
    return packFromCsv(csv, source);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Dev server runs the model; otherwise the API on :8000. A miss keeps the bundled run. */
export async function fetchLiveCatboost(): Promise<CatboostPack | null> {
  const sameOrigin = await readCsv('/api/thickness/result.csv', false);
  if (sameOrigin) return sameOrigin;
  const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:8000';
  return readCsv(`${base}/api/thickness/result.csv`, true);
}
