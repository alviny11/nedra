import type { SensorKind } from './public';

export type MeasurementQuality = 'good' | 'missing' | 'stale' | 'saturated' | 'invalid';

/** One delivered sensor reading. valueSI is null for missing samples (never 0 as a placeholder). */
export interface MeasurementSample {
  runId: string;
  sequence: number;
  sensorId: string;
  /** physical (simulated) time the reading refers to */
  simTimeS: number;
  /** wall-clock delivery time, service information only */
  receivedAt?: number;
  valueSI: number | null;
  quality: MeasurementQuality;
  unit: string;
  measurementKind: SensorKind;
}

export interface MeasurementPacket {
  schemaVersion: string;
  runId: string;
  samples: MeasurementSample[];
}

/** Actions that the diagnostician is allowed to know about (scheduled or live operator commands). */
export interface PublicControlEvent {
  simTimeS: number;
  command: import('./public').PublicCommand;
}
