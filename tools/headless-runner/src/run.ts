import type { Diagnosis, LogisticModelArtifact, MeasurementSample } from '@pipetwin/contracts';
import type { GroundTruthRecord, ScenarioFile } from '@pipetwin/contracts/truth';
import { TruthSimulator } from '@pipetwin/physics-core/truth';
import { DiagnosticsEngine, defaultDetectorConfig, demoMassBalanceGroups, type AlarmEpisode, type DetectorConfig, type FeatureVector } from '@pipetwin/diagnostics-core';

export interface RunOptions {
  model?: LogisticModelArtifact | null;
  detector?: DetectorConfig;
  batchS?: number;
  keepMeasurements?: boolean;
  /** decimate measurements kept for CSV export (seconds between kept samples per sensor) */
  measurementDecimationS?: number;
  targetReachLengthM?: number;
}

export interface RunResult {
  runId: string;
  scenarioId: string;
  truth: GroundTruthRecord;
  episodes: AlarmEpisode[];
  features: Array<{ simTimeS: number; features: FeatureVector }>;
  statusLog: Array<{ simTimeS: number; detector: string; status: string; cause: string; edges: string[]; evidence: string[] }>;
  finalDiagnoses: Record<string, Diagnosis>;
  commands: Array<{ t: number; kind: string }>;
  wallMs: number;
  simulatedS: number;
  measurements?: MeasurementSample[];
  engineStatus: string;
  waveNote?: string;
  fitNote?: string;
  modelVersion?: string;
}

export function detectorConfigFor(sc: ScenarioFile): DetectorConfig {
  return defaultDetectorConfig(demoMassBalanceGroups(sc.public));
}

/**
 * Runs the generator (truth) and the independent diagnostics on the same measurement stream.
 * The diagnostics engine only receives measurement samples and public commands.
 */
export function runScenario(sc: ScenarioFile, runId: string, opts: RunOptions = {}): RunResult {
  const t0 = performance.now();
  const sim = new TruthSimulator(sc, runId, { targetReachLengthM: opts.targetReachLengthM });
  const det = opts.detector ?? detectorConfigFor(sc);
  const engine = new DiagnosticsEngine(sc.public, det, opts.model ?? null);
  const duration = sc.public.simulation.durationS;
  const batch = opts.batchS ?? 0.5;
  const statusLog: RunResult['statusLog'] = [];
  const last: Record<string, string> = {};
  const kept: MeasurementSample[] = [];
  const lastKept = new Map<string, number>();
  const dec = opts.measurementDecimationS ?? 0;
  for (let t = batch; t <= duration + 1e-9; t += batch) {
    const samples = sim.advanceTo(t);
    engine.ingest(samples);
    engine.process();
    if (opts.keepMeasurements) {
      for (const s of samples) {
        const lk = lastKept.get(s.sensorId);
        if (lk === undefined || s.simTimeS - lk >= dec - 1e-9) {
          kept.push(s);
          lastKept.set(s.sensorId, s.simTimeS);
        }
      }
    }
    const dg = engine.diagnoses();
    for (const id of ['D0', 'D1', 'D2'] as const) {
      const d = dg[id];
      const key = `${d.status}|${d.cause}|${d.candidateEdges.map((c) => c.edgeId).join(',')}`;
      if (last[id] !== key) {
        last[id] = key;
        statusLog.push({ simTimeS: d.simTimeS, detector: id, status: d.status, cause: d.cause, edges: d.candidateEdges.map((c) => c.edgeId), evidence: d.evidence.map((e) => e.text) });
      }
    }
    if (sim.terminated) break;
  }
  const truth = sim.groundTruth();
  return {
    runId,
    scenarioId: sc.id,
    truth,
    episodes: engine.episodes.map((e) => ({ ...e, candidateEdges: e.candidateEdges.map((c) => ({ ...c })) })),
    features: engine.featureRows,
    statusLog,
    finalDiagnoses: engine.diagnoses(),
    commands: sc.public.commands.map((c) => ({ t: c.simTimeS, kind: c.kind })),
    wallMs: performance.now() - t0,
    simulatedS: truth.durationS,
    measurements: opts.keepMeasurements ? kept : undefined,
    engineStatus: `${engine.status}${engine.statusMessage ? ': ' + engine.statusMessage : ''}`,
    waveNote: engine.lastWave ? `${engine.lastWave.note} best=${JSON.stringify(engine.lastWave.best)} onsets=${engine.lastWave.onsets.map((o) => `${o.sensorId}@${o.tS.toFixed(3)}`).join(' ')}` : undefined,
    fitNote: engine.lastFit ? `${engine.lastFit.note} best=${JSON.stringify(engine.lastFit.best)}` : undefined,
    modelVersion: opts.model?.modelVersion
  };
}
