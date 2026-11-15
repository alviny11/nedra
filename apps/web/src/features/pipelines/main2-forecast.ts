import { data } from './data';
import { packFromCsv, type CatboostPack } from './catboost';

export const MAIN2_MODEL_ID = 'cb_combined_d6_MAE';
export const MAIN2_DATE = '2024-11-24';
export type ForecastPack = CatboostPack & { coverageByAsset?: Record<string, number> };
export const emptyMain2Pack = (): ForecastPack => ({ csv: 'id,segment_id,thickness_pred\n', byKey: new Map(), source: 'live' });

export function parseMain2Response(value: unknown): ForecastPack {
  const v = value as { pipelineId?: string; modelId?: string; forecastDate?: string; source?: string; count?: number; csv?: string; coverageByAsset?: Record<string, number> };
  if (v?.pipelineId !== 'MAIN-2' || v.modelId !== MAIN2_MODEL_ID || v.forecastDate !== MAIN2_DATE || v.source !== 'live' || typeof v.csv !== 'string') throw new Error('Сервер вернул другую модель или дату прогноза.');
  const group = data.groups.find(g => g.id === 'MAIN-2')!;
  const expected = group.assets.flatMap(a => a.segments.map(s => `${a.id}:${s.sid}`));
  const pack = packFromCsv(v.csv, 'live');
  if (!pack || v.count !== expected.length || pack.byKey.size !== expected.length || v.csv.trim().split(/\r?\n/).length !== expected.length + 1 || expected.some(k => !pack.byKey.has(k)) || [...pack.byKey.values()].some(x => x < 0)) throw new Error('Прогноз не покрывает все сегменты Main 2.');
  return { ...pack, coverageByAsset: v.coverageByAsset };
}

export async function fetchMain2Forecast(signal?: AbortSignal): Promise<ForecastPack> {
  const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
  const response = await fetch(`${base}/api/thickness/main-2/predict`, { method: 'POST', signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Не удалось рассчитать прогноз. Проверьте, что сервер модели запущен.');
  return parseMain2Response(await response.json());
}
