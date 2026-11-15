import { describe, expect, it, vi, afterEach } from 'vitest';
import { data } from './data';
import { fetchMain2Forecast, MAIN2_MODEL_ID, MAIN2_DATE, parseMain2Response } from './main2-forecast';

const group = data.groups.find(g => g.id === 'MAIN-2')!;
const lines = group.assets.flatMap(a => a.segments.map(s => `${a.id},${s.sid},5.5`));
const valid = () => ({ pipelineId: 'MAIN-2', modelId: MAIN2_MODEL_ID, forecastDate: MAIN2_DATE, source: 'live', count: 580, csv: `id,segment_id,thickness_pred\n${lines.join('\n')}\n` });
afterEach(() => vi.unstubAllGlobals());
describe('MAIN-2 forecast contract', () => {
  it('accepts all 580 live segments with the correct model and date', () => expect(parseMain2Response(valid()).byKey.size).toBe(580));
  it('rejects old, missing, duplicate and wrong-pipeline responses', () => {
    expect(() => parseMain2Response({ ...valid(), modelId: 'cb_history_d6_MAE' })).toThrow();
    expect(() => parseMain2Response({ ...valid(), source: 'saved' })).toThrow();
    expect(() => parseMain2Response({ ...valid(), pipelineId: 'MAIN-4' })).toThrow();
    expect(() => parseMain2Response({ ...valid(), csv: `id,segment_id,thickness_pred\n${lines.slice(1).join('\n')}\n` })).toThrow();
    expect(() => parseMain2Response({ ...valid(), csv: valid().csv + lines[0] + '\n' })).toThrow();
  });
  it('calls POST and surfaces backend failure without saved fallback', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false }); vi.stubGlobal('fetch', fetch);
    await expect(fetchMain2Forecast()).rejects.toThrow('Не удалось');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1].method).toBe('POST');
  });
});
