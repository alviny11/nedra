import type {
  FluidProfile,
  NodeConfig,
  PipeConfig,
  PublicScenarioConfig,
  SensorConfig,
  SimulationSettings,
  ValveConfig,
  PumpConfig,
  LinkConfig
} from '@pipetwin/contracts';
import { SCHEMA_VERSION } from '@pipetwin/contracts';

export function waterConst(overrides: Partial<FluidProfile> = {}): FluidProfile {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'water_const',
    name: 'Water, constant properties (verification)',
    provenance: 'synthetic',
    description: 'Accepted constants for analytic tests',
    modelVersion: 'test',
    validPressurePa: [1e3, 1e8],
    validTemperatureK: [273.15, 373.15],
    compositionDefinition: 'single phase',
    compositionBounds: { waterMassFraction: [1, 1] },
    referencePressurePa: 1e5,
    referenceTemperatureK: 293.15,
    referenceWaterMassFraction: 1,
    water: {
      densityModel: { kind: 'linear', rhoRefKgM3: 1000, thermalExpansion1K: 0 },
      viscosityModel: { kind: 'constant', muPaS: 1e-3 },
      heatCapacityJkgK: 4180,
      conductivityWmK: 0.6,
      bulkModulusPa: 2.19e12 // effectively incompressible density; wave speed from wall + this modulus
    },
    mixtureViscosityModel: { kind: 'single_phase' },
    phaseBoundaryModel: { kind: 'min_pressure', minPressurePa: 1e3, note: 'test' },
    uncertainty: { densityRel: 0, viscosityRel: 0, soundSpeedRel: 0 },
    standardConditions: { pressurePa: 101325, temperatureK: 293.15 },
    capabilities: ['M0_liquid'],
    notes: [],
    ...overrides
  };
}

export function waterWithModulus(K: number, mu = 1e-3): FluidProfile {
  const w = waterConst();
  return { ...w, id: `water_K${K}`, water: { ...w.water!, bulkModulusPa: K, viscosityModel: { kind: 'constant', muPaS: mu } } };
}

export function settings(o: Partial<SimulationSettings> = {}): SimulationSettings {
  return {
    targetReachLengthM: 25,
    minReachesPerPipe: 4,
    transportCourant: 0.5,
    maxTransportIntervalS: 1,
    frictionModel: 'colebrook',
    propertyMode: 'fixed_acoustic_variable_viscosity',
    durationS: 100,
    ...o
  };
}

export function node(id: string, kind: NodeConfig['kind'], z: number, b?: Partial<NodeConfig['boundary']>): NodeConfig {
  return {
    id,
    name: id,
    kind,
    role: 'junction',
    elevationM: z,
    display: { x: 0, y: 0 },
    boundary: b ? { temperatureK: 293.15, waterMassFraction: 1, ...b } : undefined
  };
}

export function pipe(id: string, from: string, to: string, L: number, D: number, zFrom: number, zTo: number, o: Partial<PipeConfig> = {}): PipeConfig {
  return {
    kind: 'pipe',
    id,
    name: id,
    fromNodeId: from,
    toNodeId: to,
    lengthM: L,
    innerDiameterM: D,
    wallThicknessM: 0.01,
    roughnessM: 0,
    youngModulusPa: 2e11,
    poissonRatio: 0.3,
    restraintModel: 'expansion_joints',
    elevationProfile: [
      { distanceM: 0, elevationM: zFrom },
      { distanceM: L, elevationM: zTo }
    ],
    displayPolyline: [
      { x: 0, y: 0 },
      { x: 1, y: 1 }
    ],
    thermal: { overallHeatTransferWm2K: 0, referenceOuterDiameterM: D + 0.02, ambientTemperatureK: 293.15, insulation: 'none' },
    fluidProfileId: 'water_const',
    solverModel: 'M0_liquid_moc',
    ...o
  };
}

export function valve(id: string, from: string, to: string, D: number, opening: number, stroke: number): ValveConfig {
  return {
    kind: 'valve',
    id,
    name: id,
    fromNodeId: from,
    toNodeId: to,
    diameterM: D,
    characteristic: { opening: [0.1, 0.3, 0.5, 0.7, 1.0], lossCoefficientK: [400, 30, 8, 2.5, 0.5] },
    initialOpening: opening,
    strokeTimeS: stroke,
    display: { x: 0, y: 0 }
  };
}

export function pump(id: string, from: string, to: string): PumpConfig {
  return {
    kind: 'pump',
    id,
    name: id,
    fromNodeId: from,
    toNodeId: to,
    curve: { flowM3S: [0, 0.02, 0.04, 0.06], headM: [60, 58, 52, 42] },
    referenceSpeedRpm: 2950,
    initialSpeedRatio: 1,
    speedTimeConstantS: 2,
    checkValve: true,
    allowedFlowM3S: [0, 0.07],
    display: { x: 0, y: 0 }
  };
}

export function scenario(
  nodes: NodeConfig[],
  links: LinkConfig[],
  o: { sensors?: SensorConfig[]; fluids?: FluidProfile[]; settings?: Partial<SimulationSettings> } = {}
): PublicScenarioConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'test',
    name: 'test',
    description: 'test',
    fluidProfiles: o.fluids ?? [waterConst()],
    nodes,
    links,
    sensors: o.sensors ?? [],
    commands: [],
    simulation: settings(o.settings),
    contextElements: [],
    map: { width: 100, height: 100 }
  };
}

export function pressureSensor(id: string, edgeId: string, distanceM: number, o: Partial<SensorConfig> = {}): SensorConfig {
  return {
    id,
    name: id,
    kind: 'pressure',
    edgeId,
    distanceM,
    sampleRateHz: 100,
    timeConstantS: 0,
    delayS: 0,
    noiseStdSI: 0,
    biasSI: 0,
    quantizationStepSI: 0,
    dropoutProbability: 0,
    timestampJitterS: 0,
    rangeSI: [0, 1e8],
    role: 'residual',
    availability: 'online',
    ...o
  };
}

/** synthetic oil-water profile used by transport tests (same structure as the demo profile) */
export function oilWater(): FluidProfile {
  const b = Math.log(0.045 / 0.02) / (1 / 293.15 - 1 / 313.15);
  const a = Math.log(0.02) - b / 313.15;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'oil_water_test',
    name: 'synthetic oil-water (test)',
    provenance: 'synthetic',
    description: 'test',
    modelVersion: 'test',
    validPressurePa: [1e5, 1e7],
    validTemperatureK: [273.15, 353.15],
    compositionDefinition: 'Y_w water mass fraction',
    compositionBounds: { waterMassFraction: [0, 0.44] },
    referencePressurePa: 5e5,
    referenceTemperatureK: 313.15,
    referenceWaterMassFraction: 0.15,
    oil: {
      densityModel: { kind: 'linear', rhoRefKgM3: 850, thermalExpansion1K: 7e-4 },
      viscosityModel: { kind: 'arrhenius', a, bK: b },
      heatCapacityJkgK: 2000,
      conductivityWmK: 0.13,
      bulkModulusPa: 850 * 1300 * 1300
    },
    water: {
      densityModel: { kind: 'linear', rhoRefKgM3: 1010, thermalExpansion1K: 3.5e-4 },
      viscosityModel: { kind: 'constant', muPaS: 0.65e-3 },
      heatCapacityJkgK: 4100,
      conductivityWmK: 0.6,
      bulkModulusPa: 2.3e9
    },
    mixtureViscosityModel: { kind: 'wo_emulsion_power', exponent: 2.5, maxWaterVolumeFraction: 0.4, calibrated: false },
    phaseBoundaryModel: { kind: 'min_pressure', minPressurePa: 1.5e5, note: 'test' },
    uncertainty: { densityRel: 0.01, viscosityRel: 0.1, soundSpeedRel: 0.03 },
    standardConditions: { pressurePa: 101325, temperatureK: 293.15 },
    capabilities: ['M0_liquid'],
    notes: []
  };
}
