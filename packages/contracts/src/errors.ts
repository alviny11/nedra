export type PipeTwinErrorCode =
  | 'INVALID_TOPOLOGY'
  | 'INVALID_SCHEMA'
  | 'PROFILE_OUT_OF_RANGE'
  | 'UNSUPPORTED_PHASE_REGIME'
  | 'NUMERICAL_DIVERGENCE'
  | 'INSUFFICIENT_SENSOR_DATA'
  | 'MODEL_SCHEMA_MISMATCH'
  | 'STEADY_STATE_NOT_FOUND'
  | 'UNSUPPORTED_ACTION';

export interface ApiError {
  code: PipeTwinErrorCode;
  message: string;
  fieldPath?: string;
  details?: Record<string, unknown>;
}

/** Thrown by the physics core when the model leaves its domain of validity. Never silently clipped. */
export class ModelDomainError extends Error {
  readonly code: PipeTwinErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: PipeTwinErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ModelDomainError';
    this.code = code;
    this.details = details;
  }
}

export interface ValidationIssue {
  code: PipeTwinErrorCode;
  message: string;
  fieldPath?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
