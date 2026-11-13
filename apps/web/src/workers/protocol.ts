import type { Diagnosis, LogisticModelArtifact, MeasurementSample, PublicCommand, PublicScenarioConfig } from '@pipetwin/contracts';
import type { ScenarioFile, TruthEvent, GroundTruthRecord } from '@pipetwin/contracts/truth';
import type { GridLayout } from '@pipetwin/physics-core';
import type { DetectorConfig } from '@pipetwin/diagnostics-core';

// ---------------------------------------------------------------- simulation worker (truth generator)
export type SimCommand =
  | { type: 'INIT'; scenario: ScenarioFile; runId: string; diagPort: MessagePort }
  | { type: 'START' }
  | { type: 'PAUSE' }
  | { type: 'RESET' }
  | { type: 'SET_PLAYBACK_SPEED'; value: number }
  | { type: 'APPLY_PUBLIC_CONTROL'; command: PublicCommand }
  | { type: 'APPLY_PRIVATE_EVENT'; event: TruthEvent }
  | { type: 'REQUEST_SNAPSHOT' }
  | { type: 'EXPORT_RUN' }
  | { type: 'STOP' };

export interface TruthSnapshotMsg {
  simTimeS: number;
  p: Float64Array;
  m: Float64Array;
  T: Float64Array;
  Y: Float64Array;
  nodeP: Float64Array;
  deviceMassFlow: Float64Array;
  pumpSpeed: Float64Array;
  valveOpening: Float64Array;
  leaks: Array<{ eventId: string; edgeId: string; requestedDistanceM: number; appliedDistanceM: number; snapErrorM: number; massFlowKgS: number; cumulativeMassKg: number; openFraction: number }>;
  ledger: { inventoryKg: number; initialInventoryKg: number; boundaryInflowKg: number; leakOutflowKg: number };
  activeSensorFaults: Array<{ eventId: string; sensorId: string; type: string }>;
}

export type SimEvent =
  | { type: 'READY'; layout: GridLayout; runId: string; initMs: number }
  | { type: 'SNAPSHOT'; truth: TruthSnapshotMsg; achievedSpeed: number; stepsPerSecond: number; running: boolean; samplesPerSecond: number }
  | { type: 'MODEL_STATUS'; status: 'ok' | 'stopped'; code?: string; message?: string; simTimeS: number }
  | { type: 'RUN_FINISHED'; simTimeS: number }
  | { type: 'EXPORT'; csv: string; groundTruth: GroundTruthRecord; scenario: ScenarioFile; commands: PublicCommand[]; events: TruthEvent[] }
  | { type: 'ERROR'; code: string; message: string };

// ---------------------------------------------------------------- diagnostics worker (independent)
export type DiagCommand =
  | { type: 'INIT'; publicConfig: PublicScenarioConfig; detector: DetectorConfig; model: LogisticModelArtifact | null; port: MessagePort }
  | { type: 'INGEST_MEASUREMENTS'; samples: MeasurementSample[] }
  | { type: 'APPLY_PUBLIC_CONTROL'; command: PublicCommand }
  | { type: 'RESET' }
  | { type: 'EXPORT_DIAGNOSTICS' };

/** messages arriving from the simulation worker through the dedicated port: measurements & public commands only */
export type PortMsg = { type: 'MEASUREMENTS'; samples: MeasurementSample[] } | { type: 'PUBLIC_CONTROL'; command: PublicCommand } | { type: 'RESET' };

export interface SeriesDelta {
  sensorId: string;
  t: number[];
  y: number[];
  yhat: number[];
  yhatFixed: number[];
}

export interface ObserverSnapshotMsg {
  simTimeS: number;
  p: Float64Array;
  m: Float64Array;
  T: Float64Array;
  Y: Float64Array;
  pumpSpeed: Float64Array;
  valveOpening: Float64Array;
}

export type DiagEvent =
  | {
      type: 'DIAG_UPDATE';
      simTimeS: number;
      status: string;
      statusMessage: string;
      diagnoses: Record<'D0' | 'D1' | 'D2', Diagnosis>;
      zLatest: Record<string, { zFixed: number; zAdaptive: number; sNeg: number; sPos: number; excluded: boolean }>;
      massBalance: Array<{ id: string; name: string; available: boolean; valueKgS: number; z: number; offsetKgS: number }>;
      series: SeriesDelta[];
      observer?: ObserverSnapshotMsg;
      calibrated: boolean;
      backlogSamples: number;
      processingMs: number;
      modelLoaded: boolean;
    }
  | { type: 'DIAG_EXPORT'; diagnosesLog: Diagnosis[]; episodes: unknown[]; features: unknown[] }
  | { type: 'ERROR'; code: string; message: string };
