/**
 * TRUTH-ONLY contracts. Used by the simulation (generator) runtime, the evaluator and the
 * operator "reveal" overlay. diagnostics-core must never import this module.
 */
import type { PublicScenarioConfig } from './public';

export interface LeakEvent {
  kind: 'leak';
  eventId: string;
  edgeId: string;
  distanceM: number;
  startTimeS: number;
  holeDiameterM: number;
  /** time for the open AREA fraction to go 0 -> 1 (smoothstep); 0 = abrupt */
  openingDurationS: number;
  dischargeCoefficient: number;
  externalPressurePa: number;
  outflowModel: 'liquid_orifice';
}

export type SensorFault =
  | { type: 'bias_step'; biasSI: number }
  | { type: 'drift'; rateSIPerS: number }
  | { type: 'stuck' }
  | { type: 'noise_increase'; factor: number }
  | { type: 'dropout'; probability: number };

export interface SensorFaultEvent {
  kind: 'sensor_fault';
  eventId: string;
  sensorId: string;
  startTimeS: number;
  endTimeS?: number;
  fault: SensorFault;
}

/** Hidden change of boundary fluid state (heater trip, water breakthrough, ...). Visible only through sensors. */
export interface InletChangeEvent {
  kind: 'inlet_change';
  eventId: string;
  nodeId: string;
  startTimeS: number;
  rampDurationS: number;
  temperatureK?: number;
  waterMassFraction?: number;
}

export interface AmbientChangeEvent {
  kind: 'ambient_change';
  eventId: string;
  edgeIds: string[];
  startTimeS: number;
  rampDurationS: number;
  ambientTemperatureK: number;
}

export type TruthEvent = LeakEvent | SensorFaultEvent | InletChangeEvent | AmbientChangeEvent;

export interface ProcessNoiseConfig {
  /** Ornstein-Uhlenbeck fluctuation of pressure boundaries */
  boundaryPressureStdPa: number;
  boundaryPressureTimeConstantS: number;
  /** relative OU fluctuation of source mass flows */
  sourceFlowRelStd: number;
  sourceFlowTimeConstantS: number;
}

/** Deviation of the true medium/pipe from the public passport (model error seen by the observer). */
export interface PropertyDeviation {
  viscosityFactor: number;
  bulkModulusFactor: number;
  roughnessFactor: number;
}

export interface TruthConfig {
  schemaVersion: string;
  seed: number;
  events: TruthEvent[];
  processNoise: ProcessNoiseConfig;
  propertyDeviation: PropertyDeviation;
}

export interface ScenarioFile {
  schemaVersion: string;
  id: string;
  name: string;
  description: string;
  expectedBehavior: string;
  limitations: string[];
  tags: string[];
  public: PublicScenarioConfig;
  truth: TruthConfig;
}

export interface TruthEventRealization {
  eventId: string;
  kind: TruthEvent['kind'];
  startTimeS: number;
  endTimeS?: number;
  edgeId?: string;
  requestedDistanceM?: number;
  /** the leak is applied at the nearest admissible solver grid point */
  appliedDistanceM?: number;
  snapErrorM?: number;
  holeDiameterM?: number;
  openingDurationS?: number;
  peakLeakMassFlowKgS?: number;
  totalLeakMassKg?: number;
  sensorId?: string;
  nodeId?: string;
  detail?: Record<string, unknown>;
}

export interface GroundTruthRecord {
  schemaVersion: string;
  runId: string;
  scenarioId: string;
  seed: number;
  durationS: number;
  events: TruthEventRealization[];
  /** time with no active leak, used for false-alarm rates */
  normalExposureS: number;
  propertyDeviation: PropertyDeviation;
  terminatedEarly?: { simTimeS: number; code: string; message: string };
}
