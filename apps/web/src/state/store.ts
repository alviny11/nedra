import { create } from 'zustand';
import type { Diagnosis, LogisticModelArtifact, PublicCommand } from '@pipetwin/contracts';
import type { ScenarioFile, TruthEvent } from '@pipetwin/contracts/truth';
import type { GridLayout } from '@pipetwin/physics-core';
import type { DiagEvent, ObserverSnapshotMsg, TruthSnapshotMsg } from '../workers/protocol';

export type ViewMode = 'operator' | 'diagnost';
export type Layer = 'pressure' | 'dp' | 'temperature' | 'flow' | 'composition' | 'diagnostics';
export type DiagUpdate = Extract<DiagEvent, { type: 'DIAG_UPDATE' }>;

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  expectedBehavior: string;
  tags: string[];
  durationS: number;
  scenario: ScenarioFile;
}

export interface Toast {
  id: number;
  kind: 'info' | 'warn' | 'error';
  text: string;
}

export interface AppState {
  catalog: CatalogEntry[];
  scenario: ScenarioFile | null;
  runId: string;
  layout: GridLayout | null;
  view: ViewMode;
  reveal: boolean;
  running: boolean;
  finished: boolean;
  speed: number;
  achievedSpeed: number;
  stepsPerSecond: number;
  samplesPerSecond: number;
  truth: TruthSnapshotMsg | null;
  observer: ObserverSnapshotMsg | null;
  diag: DiagUpdate | null;
  modelStop: { code: string; message: string; simTimeS: number } | null;
  selectedEdge: string | null;
  selectedSensors: string[];
  layer: Layer;
  backend: { online: boolean; version?: string; runner?: boolean; checkedAt: number };
  workers: { sim: 'starting' | 'ready' | 'error'; diag: 'starting' | 'ready' | 'error'; message?: string };
  model: LogisticModelArtifact | null;
  modelSource: string;
  toasts: Toast[];
  chartVersion: number;
  operatorLog: Array<{ simTimeS: number; text: string; hidden: boolean }>;
  appliedEvents: TruthEvent[];
  appliedCommands: PublicCommand[];
  diagLog: Diagnosis[];
  showTrials: boolean;
  /** Daily corrosion clock is stepping. Playback ×30 must not apply. */
  corrosionDays: boolean;
  set: (p: Partial<AppState>) => void;
  toast: (kind: Toast['kind'], text: string) => void;
}

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  catalog: [],
  scenario: null,
  runId: 'run',
  layout: null,
  view: 'operator',
  reveal: false,
  running: false,
  finished: false,
  speed: 1,
  achievedSpeed: 0,
  stepsPerSecond: 0,
  samplesPerSecond: 0,
  truth: null,
  observer: null,
  diag: null,
  modelStop: null,
  selectedEdge: null,
  selectedSensors: ['PT-105', 'PT-107', 'PT-111'],
  layer: 'pressure',
  backend: { online: false, checkedAt: 0 },
  workers: { sim: 'starting', diag: 'starting' },
  model: null,
  modelSource: '',
  toasts: [],
  chartVersion: 0,
  operatorLog: [],
  appliedEvents: [],
  appliedCommands: [],
  diagLog: [],
  showTrials: false,
  corrosionDays: false,
  set: (p) => set(p),
  toast: (kind, text) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, kind, text }].slice(-4) });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 9000 : 5000);
  }
}));

/** Mutable chart data (outside React state; components re-read on chartVersion changes). */
export interface SensorSeries {
  t: number[];
  y: number[];
  yhat: number[];
  yhatFixed: number[];
}

export const chartData = {
  series: new Map<string, SensorSeries>(),
  mb: { t: [] as number[], values: new Map<string, number[]>() },
  z: { t: [] as number[], values: new Map<string, number[]> () },
  baseline: null as Float64Array | null,
  reset(): void {
    this.series.clear();
    this.mb = { t: [], values: new Map() };
    this.z = { t: [], values: new Map() };
    this.baseline = null;
  }
};

const MAX_POINTS = 3600;

export function appendSeries(delta: DiagUpdate['series']): void {
  for (const d of delta) {
    let s = chartData.series.get(d.sensorId);
    if (!s) {
      s = { t: [], y: [], yhat: [], yhatFixed: [] };
      chartData.series.set(d.sensorId, s);
    }
    s.t.push(...d.t);
    s.y.push(...d.y);
    s.yhat.push(...d.yhat);
    s.yhatFixed.push(...d.yhatFixed);
    if (s.t.length > MAX_POINTS) {
      const cut = s.t.length - MAX_POINTS;
      s.t.splice(0, cut);
      s.y.splice(0, cut);
      s.yhat.splice(0, cut);
      s.yhatFixed.splice(0, cut);
    }
  }
}

export function appendDiagScalars(u: DiagUpdate): void {
  const t = u.simTimeS;
  const mb = chartData.mb;
  if (!mb.t.length || t - mb.t[mb.t.length - 1]! >= 0.9) {
    mb.t.push(t);
    for (const g of u.massBalance) {
      const arr = mb.values.get(g.id) ?? [];
      arr.push(g.available && Number.isFinite(g.valueKgS) ? g.valueKgS - g.offsetKgS : Number.NaN);
      mb.values.set(g.id, arr);
    }
    const z = chartData.z;
    z.t.push(t);
    for (const [sid, v] of Object.entries(u.zLatest)) {
      const arr = z.values.get(sid) ?? [];
      while (arr.length < z.t.length - 1) arr.push(Number.NaN);
      arr.push(u.calibrated ? v.zAdaptive : Number.NaN);
      z.values.set(sid, arr);
    }
    if (mb.t.length > MAX_POINTS) {
      mb.t.splice(0, 600);
      for (const a of mb.values.values()) a.splice(0, 600);
      z.t.splice(0, 600);
      for (const a of z.values.values()) a.splice(0, 600);
    }
  }
}
