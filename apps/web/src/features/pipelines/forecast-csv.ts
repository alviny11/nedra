export interface ForecastPack {
  csv: string;
  byKey: Map<string, number>;
  source: 'live' | 'saved';
}

export function parseForecastCsv(csv: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const [id, sid, pred] = line.split(',');
    const value = Number(pred);
    if (id && sid != null && sid !== '' && Number.isFinite(value)) map.set(`${id}:${sid}`, value);
  }
  return map;
}

export function packFromCsv(csv: string, source: 'live' | 'saved'): ForecastPack | null {
  const trimmed = csv.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!trimmed.startsWith('id,segment_id,thickness_pred')) return null;
  const byKey = parseForecastCsv(trimmed);
  if (!byKey.size) return null;
  return { csv: `${trimmed}\n`, byKey, source };
}

export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

