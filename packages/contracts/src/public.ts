/**
 * Public (diagnostician-visible) contracts.
 * Everything here may be seen by diagnostics-core. Hidden truth (leaks, sensor faults,
 * true property deviations, noise seeds) lives in ./truth.ts and must never be imported
 * by diagnostics-core.
 *
 * All physical quantities are SI: m, s, Pa (absolute), K, kg, m3.
 */

export const SCHEMA_VERSION = '1.0.0' as const;

export interface XY {
  x: number;
  y: number;
}

export interface ElevationPoint {
  distanceM: number;
  elevationM: number;
}

export type Provenance = 'measured' | 'correlation' | 'synthetic';

// ---------------------------------------------------------------- fluids

export interface LinearDensityModel {
  kind: 'linear';
  /** density at (referencePressurePa, referenceTemperatureK) */
  rhoRefKgM3: number;
  /** isobaric thermal expansion coefficient beta_T [1/K] */
  thermalExpansion1K: number;
}

export type ViscosityModel =
  | { kind: 'constant'; muPaS: number }
  | {
      /** ln(mu) = a + b / T, T in K; valid only inside the profile temperature bounds */
      kind: 'arrhenius';
      a: number;
      bK: number;
    }
  | {
      /** positive log-interpolation of tabulated points; no extrapolation outside the table */
      kind: 'table_log';
      temperatureK: number[];
      viscosityPaS: number[];
    };

export interface PhaseProperties {
  densityModel: LinearDensityModel;
  viscosityModel: ViscosityModel;
  heatCapacityJkgK: number;
  conductivityWmK: number;
  /** isentropic bulk modulus K_s of the bulk liquid [Pa]; sound speed follows as sqrt(K_s/rho) */
  bulkModulusPa: number;
}

export type MixtureViscosityModel =
  | { kind: 'single_phase' }
  | {
      /**
       * Water-in-oil emulsion branch only: mu_eff = mu_oil(T) * (1 - alpha_w)^(-exponent).
       * Synthetic smooth dependence restricted to alpha_w <= maxWaterVolumeFraction; no inversion is modelled.
       */
      kind: 'wo_emulsion_power';
      exponent: number;
      maxWaterVolumeFraction: number;
      calibrated: boolean;
    };

export interface FluidProfile {
  schemaVersion: string;
  id: string;
  name: string;
  provenance: Provenance;
  sourceUrl?: string;
  description: string;
  modelVersion: string;
  validPressurePa: [number, number];
  validTemperatureK: [number, number];
  /** human readable definition of composition variables */
  compositionDefinition: string;
  compositionBounds: { waterMassFraction: [number, number] };
  referencePressurePa: number;
  referenceTemperatureK: number;
  referenceWaterMassFraction: number;
  oil?: PhaseProperties;
  water?: PhaseProperties;
  mixtureViscosityModel: MixtureViscosityModel;
  /** below this absolute pressure the liquid model (M0) is not valid (gas release / cavitation) */
  phaseBoundaryModel: { kind: 'min_pressure'; minPressurePa: number; note: string };
  uncertainty: { densityRel: number; viscosityRel: number; soundSpeedRel: number };
  standardConditions: { pressurePa: number; temperatureK: number };
  /** capabilities this profile has been verified for */
  capabilities: Array<'M0_liquid' | 'M1_acoustic_experiment'>;
  notes: string[];
}

// ---------------------------------------------------------------- topology

export type NodeKind = 'junction' | 'pressure_boundary' | 'mass_flow_source' | 'closed_end';

export type NodeRole =
  | 'junction'
  | 'separator_liquid'
  | 'separator_water'
  | 'treatment_inlet'
  | 'water_outlet'
  | 'tank'
  | 'well_pad_liquid'
  | 'pump_suction'
  | 'pump_discharge'
  | 'valve_port';

export interface NodeBoundary {
  /** absolute pressure setpoint for pressure boundaries */
  pressurePa?: number;
  /** injected mass flow for sources (positive into network) */
  massFlowKgS?: number;
  /** temperature of fluid entering the network from this boundary */
  temperatureK: number;
  /** water mass fraction in liquid entering the network from this boundary */
  waterMassFraction: number;
}

export interface NodeConfig {
  id: string;
  name: string;
  kind: NodeKind;
  role: NodeRole;
  elevationM: number;
  display: XY;
  boundary?: NodeBoundary;
}

export type RestraintModel = 'expansion_joints' | 'anchored_upstream' | 'anchored_throughout';

export interface PipeThermal {
  /** overall heat-transfer coefficient referred to referenceOuterDiameterM [W/(m2 K)] */
  overallHeatTransferWm2K: number;
  referenceOuterDiameterM: number;
  ambientTemperatureK: number;
  insulation: string;
}

export interface PipeConfig {
  kind: 'pipe';
  id: string;
  name: string;
  fromNodeId: string;
  toNodeId: string;
  lengthM: number;
  innerDiameterM: number;
  wallThicknessM: number;
  roughnessM: number;
  youngModulusPa: number;
  poissonRatio: number;
  restraintModel: RestraintModel;
  /** physical elevation profile used by the solver (not derived from the drawing) */
  elevationProfile: ElevationPoint[];
  /** drawing only */
  displayPolyline: XY[];
  thermal: PipeThermal;
  fluidProfileId: string;
  solverModel: 'M0_liquid_moc';
  localLossK?: number;
}

export interface PumpConfig {
  kind: 'pump';
  id: string;
  name: string;
  fromNodeId: string;
  toNodeId: string;
  /** reference head curve H_ref(Q) at the reference speed */
  curve: { flowM3S: number[]; headM: number[] };
  referenceSpeedRpm: number;
  initialSpeedRatio: number;
  /** first-order actuator time constant for speed commands */
  speedTimeConstantS: number;
  checkValve: boolean;
  /** allowed local volumetric flow range at reference speed */
  allowedFlowM3S: [number, number];
  efficiency?: { flowM3S: number[]; eta: number[] };
  display: XY;
}

export interface ValveConfig {
  kind: 'valve';
  id: string;
  name: string;
  fromNodeId: string;
  toNodeId: string;
  diameterM: number;
  /** loss coefficient K(opening) referred to the valve bore; opening 0 = closed (Q = 0) */
  characteristic: { opening: number[]; lossCoefficientK: number[] };
  initialOpening: number;
  /** time for a full 0 -> 1 stroke */
  strokeTimeS: number;
  display: XY;
}

export type LinkConfig = PipeConfig | PumpConfig | ValveConfig;

// ---------------------------------------------------------------- sensors

export type SensorKind = 'pressure' | 'temperature' | 'massFlow' | 'volumeFlow' | 'waterFraction';
/**
 * boundary_input: drives observer boundary conditions, never used as an independent residual.
 * residual: compared with observer prediction.
 * state_assimilation: reserved (not used by the current observers).
 */
export type SensorRole = 'boundary_input' | 'residual' | 'state_assimilation';

export interface SensorConfig {
  id: string;
  name: string;
  kind: SensorKind;
  /** either edge + distance, or node */
  edgeId?: string;
  distanceM?: number;
  nodeId?: string;
  sampleRateHz: number;
  timeConstantS: number;
  delayS: number;
  noiseStdSI: number;
  /** known calibration bias (normally 0). Hidden bias faults are truth-only. */
  biasSI: number;
  quantizationStepSI: number;
  dropoutProbability: number;
  timestampJitterS: number;
  rangeSI: [number, number];
  role: SensorRole;
  availability: 'online' | 'offline';
  /** for boundary inputs: the boundary node whose condition this sensor measures */
  boundaryNodeId?: string;
}

/** waterFraction sensors report the local water VOLUME fraction alpha_w in the liquid (water cut). */
export const SENSOR_UNITS: Record<SensorKind, string> = {
  pressure: 'Pa',
  temperature: 'K',
  massFlow: 'kg/s',
  volumeFlow: 'm3/s',
  waterFraction: '1'
};

// ---------------------------------------------------------------- public commands

export type PublicCommand =
  | { kind: 'pump_speed'; id: string; simTimeS: number; targetId: string; speedRatio: number }
  | { kind: 'valve_opening'; id: string; simTimeS: number; targetId: string; opening: number }
  | { kind: 'boundary_pressure'; id: string; simTimeS: number; targetId: string; pressurePa: number }
  | { kind: 'source_mass_flow'; id: string; simTimeS: number; targetId: string; massFlowKgS: number };

// ---------------------------------------------------------------- context (not computed in M0)

export interface ContextElement {
  id: string;
  kind: 'well_pad' | 'gas_liquid_line' | 'gas_line' | 'separator' | 'gas_outlet' | 'treatment' | 'water_injection';
  name: string;
  polyline?: XY[];
  position?: XY;
  note: string;
  /** model level available for this element */
  modelLevel: 'context_only' | 'M1_acoustic_experiment';
}

export interface SimulationSettings {
  targetReachLengthM: number;
  minReachesPerPipe: number;
  /** Courant number for the composition/temperature transport sub-steps */
  transportCourant: number;
  maxTransportIntervalS: number;
  frictionModel: 'colebrook' | 'haaland';
  /** M0 mode 1: fixed reference rho and c per pipe, viscosity follows transported T and Y_w */
  propertyMode: 'fixed_acoustic_variable_viscosity' | 'fixed_all';
  durationS: number;
}

export interface PublicScenarioConfig {
  schemaVersion: string;
  id: string;
  name: string;
  description: string;
  fluidProfiles: FluidProfile[];
  nodes: NodeConfig[];
  links: LinkConfig[];
  sensors: SensorConfig[];
  commands: PublicCommand[];
  simulation: SimulationSettings;
  contextElements: ContextElement[];
  map: { width: number; height: number };
}
