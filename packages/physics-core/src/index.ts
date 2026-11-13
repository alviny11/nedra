// Public physics model of PipeTwin. Contains no truth/event types: diagnostics may import this entry.
export * from './units';
export * from './numerics/rng';
export * from './numerics/solve';
export * from './numerics/interp';
export * from './fluids/fluidModel';
export * from './friction/friction';
export * from './equipment/devices';
export * from './leaks/orifice';
export * from './topology/compile';
export * from './steady/hydraulics';
export * from './steady/initialize';
export * from './transient/network';
export * from './transient/snapshot';
export * from './sensors/probe';
export * from './sensors/response';
export * from './sensors/sensorBank';
export * from './validation/validateScenario';
export * from './model/build';

export const PHYSICS_CORE_VERSION = '0.1.0';
export const MODEL_CAPABILITIES = {
  M0_liquid_moc: { status: 'supported', mode: 'fixed_acoustic_variable_viscosity' },
  conservative_variable_property: { status: 'not_implemented' },
  M1_homogeneous_frozen: { status: 'acoustic_helper_only' },
  M2_HEM: { status: 'not_implemented' },
  drift_flux: { status: 'not_implemented' },
  gas_leak: { status: 'formula_only_not_in_solver' }
} as const;
