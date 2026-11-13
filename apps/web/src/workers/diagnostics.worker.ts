/// <reference lib="webworker" />
/**
 * Diagnostics worker: receives ONLY measurements and public commands (via the port from the simulation
 * worker) plus the public configuration. It has no APPLY_PRIVATE_EVENT command and never sees truth.
 */
import type { Diagnosis, LogisticModelArtifact, MeasurementSample, PublicScenarioConfig } from '@pipetwin/contracts';
import { DiagnosticsEngine, type DetectorConfig } from '@pipetwin/diagnostics-core';
import { fieldSnapshot } from '@pipetwin/physics-core';
import type { DiagCommand, DiagEvent, ObserverSnapshotMsg, PortMsg, SeriesDelta } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let engine: DiagnosticsEngine | null = null;
let cfg: PublicScenarioConfig | null = null;
let det: DetectorConfig | null = null;
let model: LogisticModelArtifact | null = null;
let queue: MeasurementSample[] = [];
const sentIdx = new Map<string, number>();
let lastPost = 0;
let lastObserverPost = 0;
const log: Diagnosis[] = [];
const lastKey: Record<string, string> = {};

const post = (m: DiagEvent, transfer: Transferable[] = []): void => self.postMessage(m, transfer);

function reset(): void {
  if (!cfg || !det) return;
  engine = new DiagnosticsEngine(cfg, det, model);
  queue = [];
  sentIdx.clear();
  log.length = 0;
  for (const k of Object.keys(lastKey)) delete lastKey[k];
}

function pump(): void {
  if (!engine) return;
  const t0 = performance.now();
  if (queue.length) {
    engine.ingest(queue);
    queue = [];
  }
  try {
    engine.process();
  } catch (e) {
    post({ type: 'ERROR', code: 'DIAGNOSTICS_ERROR', message: (e as Error).message });
    return;
  }
  const dt = performance.now() - t0;
  const now = performance.now();
  if (now - lastPost < 200) return;
  lastPost = now;
  const diagnoses = engine.diagnoses();
  for (const id of ['D0', 'D1', 'D2'] as const) {
    const d = diagnoses[id];
    const key = `${d.status}|${d.cause}|${d.candidateEdges.map((c) => c.edgeId).join(',')}`;
    if (lastKey[id] !== key) {
      lastKey[id] = key;
      log.push(d);
    }
  }
  const series: SeriesDelta[] = [];
  for (const [sid, s] of engine.uiSeries) {
    const from = sentIdx.get(sid) ?? 0;
    const start = Math.min(from, s.t.length);
    if (start < s.t.length) {
      series.push({ sensorId: sid, t: s.t.slice(start), y: s.y.slice(start), yhat: s.yhat.slice(start), yhatFixed: s.yhatFixed.slice(start) });
    }
    sentIdx.set(sid, s.t.length);
  }
  const zLatest: Record<string, { zFixed: number; zAdaptive: number; sNeg: number; sPos: number; excluded: boolean }> = {};
  for (const [sid, ch] of engine.resAdapt) {
    zLatest[sid] = { zFixed: engine.resFixed.get(sid)?.z ?? 0, zAdaptive: ch.z, sNeg: ch.sNeg, sPos: ch.sPos, excluded: false };
  }
  let observer: ObserverSnapshotMsg | undefined;
  const transfer: Transferable[] = [];
  if (engine.adaptive.model && now - lastObserverPost > 300) {
    lastObserverPost = now;
    const f = fieldSnapshot(engine.adaptive.model);
    observer = { simTimeS: f.simTimeS, p: f.p, m: f.m, T: f.T, Y: f.Y, pumpSpeed: f.pumpSpeed, valveOpening: f.valveOpening };
    transfer.push(f.p.buffer, f.m.buffer, f.T.buffer, f.Y.buffer);
  }
  post(
    {
      type: 'DIAG_UPDATE',
      simTimeS: engine.simTimeS,
      status: engine.status,
      statusMessage: engine.statusMessage,
      diagnoses,
      zLatest,
      massBalance: engine.massBalanceSummary(),
      series,
      observer,
      calibrated: engine.calibrated,
      backlogSamples: queue.length,
      processingMs: dt,
      modelLoaded: !!model
    },
    transfer
  );
}

function onPort(ev: MessageEvent<PortMsg>): void {
  const m = ev.data;
  if (m.type === 'MEASUREMENTS') {
    for (const s of m.samples) queue.push(s);
    pump();
  } else if (m.type === 'PUBLIC_CONTROL') {
    engine?.applyPublicControl(m.command);
  } else if (m.type === 'RESET') {
    reset();
  }
}

self.onmessage = (ev: MessageEvent<DiagCommand>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'INIT':
      cfg = msg.publicConfig;
      det = msg.detector;
      model = msg.model;
      msg.port.onmessage = onPort;
      reset();
      break;
    case 'INGEST_MEASUREMENTS':
      for (const s of msg.samples) queue.push(s);
      pump();
      break;
    case 'APPLY_PUBLIC_CONTROL':
      engine?.applyPublicControl(msg.command);
      break;
    case 'RESET':
      reset();
      break;
    case 'EXPORT_DIAGNOSTICS':
      post({ type: 'DIAG_EXPORT', diagnosesLog: log.slice(), episodes: engine?.episodes ?? [], features: engine?.featureRows ?? [] });
      break;
  }
};
