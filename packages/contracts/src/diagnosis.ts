export type DiagnosisStatus = 'normal' | 'suspected' | 'confirmed' | 'ambiguous' | 'recovering' | 'unavailable';
export type DiagnosisCause = 'leak' | 'operating_change' | 'sensor_fault' | 'composition_change' | 'unknown';
export type DetectorId = 'D0' | 'D1' | 'D2';

export interface CandidateEdge {
  edgeId: string;
  /** lower is better; method-specific misfit */
  misfit: number;
  /** relative support in [0,1] among returned candidates (not a calibrated probability) */
  support: number;
  estimatedDistanceM?: number;
  /** range of admissible candidate positions on this edge (not a statistically calibrated interval) */
  intervalM?: [number, number];
  /** mass_balance_zone: only the control volume of the balance in deficit is known (no position on the edge) */
  method: 'wave_arrival' | 'steady_residual_fit' | 'nearest_sensor' | 'mass_balance_zone';
}

export interface EvidenceItem {
  code: string;
  text: string;
  sensorIds?: string[];
  value?: number;
}

export interface Diagnosis {
  schemaVersion: string;
  id: string;
  detector: DetectorId;
  detectorVersion: string;
  simTimeS: number;
  status: DiagnosisStatus;
  cause: DiagnosisCause;
  affectedSensorIds: string[];
  candidateEdges: CandidateEdge[];
  estimatedDistanceM?: number;
  intervalM?: [number, number];
  estimatedLeakMassFlowKgs?: number;
  /** detector score (unitless, detector specific); not a probability */
  score?: number;
  /** only when calibration on independent validation data was performed */
  calibratedProbability?: number;
  causeScores?: Partial<Record<DiagnosisCause | 'normal', number>>;
  evidence: EvidenceItem[];
  limitations: string[];
  inputTimeRange: [number, number];
  firstAlarmTimeS?: number;
  episodeId?: string;
}
