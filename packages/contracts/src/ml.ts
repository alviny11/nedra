export interface LogisticModelArtifact {
  schemaVersion: string;
  modelVersion: string;
  featureSchemaVersion: string;
  kind: 'multinomial_logistic';
  classes: string[];
  featureNames: string[];
  scalerMean: number[];
  scalerScale: number[];
  /** shape [classes][features] (scikit-learn coef_) */
  coefficients: number[][];
  intercepts: number[];
  classMapping: Record<string, string>;
  missingFeaturePolicy: 'impute_scaler_mean';
  decisionThresholds: { minTopScore: number };
  calibration: { status: 'validated' | 'not_validated'; method?: string; brierValidation?: number; note: string };
  trainingMetadata: Record<string, unknown>;
  evaluationSummary: Record<string, unknown>;
  parity?: { goldenFile: string; maxAbsDiff: number };
}

export interface FeatureSchema {
  featureSchemaVersion: string;
  windowS: number;
  strideS: number;
  features: Array<{ name: string; description: string; unit: string }>;
}
