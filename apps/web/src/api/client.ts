import type { Diagnosis, MeasurementSample } from '@pipetwin/contracts';
import type { GroundTruthRecord, ScenarioFile } from '@pipetwin/contracts/truth';
import type { components } from './schema';

type Health = components['schemas']['Health'];

const BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:8000';

async function req<T>(path: string, init?: RequestInit, timeoutMs = 2500): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}${path}`, { ...init, signal: ctl.signal, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    const text = await r.text();
    const data = text ? (JSON.parse(text) as T & { code?: string; message?: string }) : undefined;
    return r.ok ? { ok: true, status: r.status, data } : { ok: false, status: r.status, error: `${data?.code ?? r.status}: ${data?.message ?? ''}` };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

function parseCsv(csv: string): MeasurementSample[] {
  const lines = csv.trim().split('\n').slice(1);
  return lines.map((l) => {
    const [runId, sequence, sensorId, t, v, quality, unit, kind] = l.split(',');
    return { runId: runId!, sequence: Number(sequence), sensorId: sensorId!, simTimeS: Number(t), valueSI: v === '' ? null : Number(v), quality: quality as MeasurementSample['quality'], unit: unit!, measurementKind: kind as MeasurementSample['measurementKind'] };
  });
}

export const api = {
  base: BASE,
  async health(): Promise<Health | null> {
    const r = await req<Health>('/api/health', undefined, 1500);
    return r.ok && r.data ? r.data : null;
  },
  async createRun(runId: string, scenarioId: string): Promise<boolean> {
    return (await req('/api/runs', { method: 'POST', body: JSON.stringify({ runId, scenarioId, versions: { web: '0.1.0', schema: '1.0.0' } }) })).ok;
  },
  async saveScenario(sc: ScenarioFile): Promise<{ ok: boolean; error?: string }> {
    const r = await req('/api/scenarios', { method: 'POST', body: JSON.stringify(sc) }, 10000);
    return { ok: r.ok, error: r.error };
  },
  async uploadRun(runId: string, csv: string, diagnoses: Diagnosis[], truth: GroundTruthRecord): Promise<boolean> {
    const samples = parseCsv(csv);
    for (let i = 0; i < samples.length; i += 50000) {
      const r = await req(`/api/runs/${runId}/measurements`, { method: 'POST', body: JSON.stringify({ schemaVersion: '1.0.0', runId, samples: samples.slice(i, i + 50000) }) }, 30000);
      if (!r.ok) return false;
    }
    const d = await req(`/api/runs/${runId}/diagnoses`, { method: 'POST', body: JSON.stringify(diagnoses) }, 10000);
    const t = await req(`/api/runs/${runId}/ground-truth`, { method: 'POST', body: JSON.stringify(truth) }, 10000);
    return d.ok && t.ok;
  }
};
