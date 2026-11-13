import type {
  ContextElement,
  ElevationPoint,
  NodeConfig,
  PipeConfig,
  PublicCommand,
  PublicScenarioConfig,
  PumpConfig,
  SensorConfig,
  ValveConfig,
  XY
} from '@pipetwin/contracts';
import { SCHEMA_VERSION } from '@pipetwin/contracts';
import type { ScenarioFile, TruthConfig, TruthEvent } from '@pipetwin/contracts/truth';
import { syntheticOilWater, waterTabulated } from './profiles';

/**
 * Conditional field ("условное месторождение"): two separators' worth of liquid after first-stage
 * separation (ДНС-1 with pump P-1, pads K-3 and K-4 with their own preliminary water knockout
 * pumping at metered flow), collector junctions, control valve before the treatment unit (УПН),
 * a normally-closed relief line to a buffer tank and a separate produced-water line to the
 * water-injection pump station (КНС). Wells and gas-liquid lines are CONTEXT ONLY in M0.
 * The layout is synthetic and does not reproduce a real field.
 */

export type SensorProfile = 'high_rate' | 'low_rate';

const STEEL = { youngModulusPa: 2.06e11, poissonRatio: 0.3, roughnessM: 4.5e-5 };
const SOIL_K = 278.15;

function node(id: string, name: string, kind: NodeConfig['kind'], role: NodeConfig['role'], z: number, x: number, y: number, boundary?: NodeConfig['boundary']): NodeConfig {
  return { id, name, kind, role, elevationM: z, display: { x, y }, boundary };
}

function pipe(
  id: string,
  name: string,
  from: string,
  to: string,
  L: number,
  D: number,
  wall: number,
  profile: ElevationPoint[] | [number, number],
  poly: XY[],
  fluid: string,
  U = 2.5
): PipeConfig {
  const ep: ElevationPoint[] =
    typeof profile[0] === 'number'
      ? [
          { distanceM: 0, elevationM: profile[0] as number },
          { distanceM: L, elevationM: profile[1] as number }
        ]
      : (profile as ElevationPoint[]);
  return {
    kind: 'pipe',
    id,
    name,
    fromNodeId: from,
    toNodeId: to,
    lengthM: L,
    innerDiameterM: D,
    wallThicknessM: wall,
    ...STEEL,
    restraintModel: 'anchored_throughout',
    elevationProfile: ep,
    displayPolyline: poly,
    thermal: { overallHeatTransferWm2K: U, referenceOuterDiameterM: D + 2 * wall, ambientTemperatureK: SOIL_K, insulation: 'подземная прокладка без изоляции (синтетическое U)' },
    fluidProfileId: fluid,
    solverModel: 'M0_liquid_moc'
  };
}

interface SensorSpec {
  rateHz: number;
  tau: number;
  noise: number;
  quant: number;
  jitter: number;
  dropout: number;
  range: [number, number];
}

function specs(profile: SensorProfile): Record<'p' | 'pb' | 'f' | 't' | 'w', SensorSpec> {
  const hi = profile === 'high_rate';
  return {
    p: hi
      ? { rateHz: 50, tau: 0.02, noise: 1500, quant: 100, jitter: 0.002, dropout: 0.001, range: [0, 4e6] }
      : { rateHz: 1, tau: 0.5, noise: 1500, quant: 500, jitter: 0.05, dropout: 0.005, range: [0, 4e6] },
    pb: { rateHz: hi ? 10 : 1, tau: 0.1, noise: 1000, quant: 100, jitter: hi ? 0.002 : 0.05, dropout: 0.001, range: [0, 4e6] },
    f: { rateHz: 2, tau: 1.0, noise: 0.25, quant: 0.01, jitter: 0.01, dropout: 0.002, range: [-50, 250] },
    t: { rateHz: 1, tau: 15, noise: 0.1, quant: 0.01, jitter: 0.01, dropout: 0.002, range: [253.15, 393.15] },
    w: { rateHz: 0.5, tau: 10, noise: 0.004, quant: 0.001, jitter: 0.01, dropout: 0.002, range: [0, 1] }
  };
}

function sensor(
  id: string,
  name: string,
  kind: SensorConfig['kind'],
  loc: { nodeId: string } | { edgeId: string; distanceM: number },
  s: SensorSpec,
  role: SensorConfig['role'],
  boundaryNodeId?: string
): SensorConfig {
  return {
    id,
    name,
    kind,
    ...loc,
    sampleRateHz: s.rateHz,
    timeConstantS: s.tau,
    delayS: 0,
    noiseStdSI: s.noise,
    biasSI: 0,
    quantizationStepSI: s.quant,
    dropoutProbability: s.dropout,
    timestampJitterS: s.jitter,
    rangeSI: s.range,
    role,
    availability: 'online',
    boundaryNodeId
  };
}

export interface DemoOptions {
  sensorProfile?: SensorProfile;
  durationS?: number;
  targetReachLengthM?: number;
  commands?: PublicCommand[];
  id?: string;
  name?: string;
}

export function buildDemoPublic(o: DemoOptions = {}): PublicScenarioConfig {
  const OW = 'synthetic_oil_water';
  const W = 'water_tabulated';
  const nodes: NodeConfig[] = [
    node('sep1', 'С-1: нефть (выход жидкости)', 'pressure_boundary', 'separator_liquid', 120, 290, 320, { pressurePa: 4.2e5, temperatureK: 323.15, waterMassFraction: 0.15 }),
    node('p1s', 'Н-1: приём', 'junction', 'pump_suction', 112, 360, 330),
    node('p1d', 'Н-1: нагнетание', 'junction', 'pump_discharge', 112, 400, 330),
    node('j1', 'Узел У-1', 'junction', 'junction', 104, 650, 330),
    node('k3', 'Куст-3 (УПСВ)', 'mass_flow_source', 'well_pad_liquid', 131, 600, 110, { massFlowKgS: 19, temperatureK: 318.15, waterMassFraction: 0.3 }),
    node('j2', 'Узел У-2', 'junction', 'junction', 97, 830, 400),
    node('k4', 'Куст-4 (УПСВ)', 'mass_flow_source', 'well_pad_liquid', 86, 800, 640, { massFlowKgS: 12, temperatureK: 313.15, waterMassFraction: 0.2 }),
    node('v1i', 'ЗД-1: вход', 'junction', 'valve_port', 92, 960, 400),
    node('v1o', 'ЗД-1: выход', 'junction', 'valve_port', 92, 1000, 400),
    node('upn', 'УПН: вход', 'pressure_boundary', 'treatment_inlet', 92, 1090, 400, { pressurePa: 5.0e5, temperatureK: 313.15, waterMassFraction: 0.2 }),
    node('v2i', 'ЗД-2: вход', 'junction', 'valve_port', 100, 680, 520),
    node('tank', 'Буферная ёмкость Е-1', 'pressure_boundary', 'tank', 100, 720, 560, { pressurePa: 4.0e5, temperatureK: 303.15, waterMassFraction: 0.2 }),
    node('sepw', 'С-1: вода (выход)', 'pressure_boundary', 'separator_water', 120, 290, 370, { pressurePa: 4.2e5, temperatureK: 323.15, waterMassFraction: 1 }),
    node('wout', 'КНС: приём', 'pressure_boundary', 'water_outlet', 80, 330, 660, { pressurePa: 6.5e5, temperatureK: 313.15, waterMassFraction: 1 })
  ];
  const links: Array<PipeConfig | PumpConfig | ValveConfig> = [
    pipe('e1', 'С-1 → Н-1', 'sep1', 'p1s', 150, 0.309, 0.008, [120, 112], [{ x: 290, y: 320 }, { x: 360, y: 330 }], OW),
    pipe(
      'e2',
      'Н-1 → У-1 (напорный)',
      'p1d',
      'j1',
      3200,
      0.259,
      0.007,
      [
        { distanceM: 0, elevationM: 112 },
        { distanceM: 800, elevationM: 118 },
        { distanceM: 1600, elevationM: 126 },
        { distanceM: 2400, elevationM: 115 },
        { distanceM: 3200, elevationM: 104 }
      ],
      [{ x: 400, y: 330 }, { x: 470, y: 370 }, { x: 560, y: 360 }, { x: 650, y: 330 }],
      OW
    ),
    pipe(
      'e3',
      'Куст-3 → У-1',
      'k3',
      'j1',
      2100,
      0.15,
      0.0045,
      [
        { distanceM: 0, elevationM: 131 },
        { distanceM: 1000, elevationM: 122 },
        { distanceM: 2100, elevationM: 104 }
      ],
      [{ x: 600, y: 110 }, { x: 620, y: 220 }, { x: 650, y: 330 }],
      OW
    ),
    pipe(
      'e4',
      'У-1 → У-2 (коллектор)',
      'j1',
      'j2',
      2800,
      0.309,
      0.008,
      [
        { distanceM: 0, elevationM: 104 },
        { distanceM: 1400, elevationM: 94 },
        { distanceM: 2800, elevationM: 97 }
      ],
      [{ x: 650, y: 330 }, { x: 740, y: 380 }, { x: 830, y: 400 }],
      OW
    ),
    pipe(
      'e5',
      'Куст-4 → У-2',
      'k4',
      'j2',
      1500,
      0.125,
      0.004,
      [
        { distanceM: 0, elevationM: 86 },
        { distanceM: 800, elevationM: 92 },
        { distanceM: 1500, elevationM: 97 }
      ],
      [{ x: 800, y: 640 }, { x: 820, y: 520 }, { x: 830, y: 400 }],
      OW
    ),
    pipe(
      'e6',
      'У-2 → ЗД-1 (коллектор)',
      'j2',
      'v1i',
      2400,
      0.309,
      0.008,
      [
        { distanceM: 0, elevationM: 97 },
        { distanceM: 1200, elevationM: 101 },
        { distanceM: 2400, elevationM: 92 }
      ],
      [{ x: 830, y: 400 }, { x: 900, y: 420 }, { x: 960, y: 400 }],
      OW
    ),
    pipe('e7', 'ЗД-1 → УПН', 'v1o', 'upn', 300, 0.309, 0.008, [92, 92], [{ x: 1000, y: 400 }, { x: 1090, y: 400 }], OW),
    pipe('e8', 'У-1 → ЗД-2 (линия сброса)', 'j1', 'v2i', 800, 0.207, 0.006, [104, 100], [{ x: 650, y: 330 }, { x: 670, y: 430 }, { x: 680, y: 520 }], OW),
    pipe(
      'e9',
      'С-1 → КНС (водовод)',
      'sepw',
      'wout',
      1800,
      0.15,
      0.006,
      [
        { distanceM: 0, elevationM: 120 },
        { distanceM: 900, elevationM: 100 },
        { distanceM: 1800, elevationM: 80 }
      ],
      [{ x: 290, y: 370 }, { x: 270, y: 500 }, { x: 330, y: 660 }],
      W
    ),
    {
      kind: 'pump',
      id: 'P1',
      name: 'Насос Н-1 (ДНС-1)',
      fromNodeId: 'p1s',
      toNodeId: 'p1d',
      curve: { flowM3S: [0, 0.03, 0.06, 0.09, 0.12], headM: [150, 146, 135, 117, 92] },
      referenceSpeedRpm: 2970,
      initialSpeedRatio: 1,
      speedTimeConstantS: 4,
      checkValve: true,
      allowedFlowM3S: [0, 0.13],
      efficiency: { flowM3S: [0.02, 0.05, 0.08, 0.11], eta: [0.45, 0.68, 0.76, 0.7] },
      display: { x: 380, y: 330 }
    },
    {
      kind: 'valve',
      id: 'V1',
      name: 'Регулирующая задвижка ЗД-1',
      fromNodeId: 'v1i',
      toNodeId: 'v1o',
      diameterM: 0.25,
      characteristic: {
        opening: [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
        lossCoefficientK: [3000, 750, 160, 60, 28, 14, 7.5, 4.0, 2.0, 0.8, 0.3]
      },
      initialOpening: 0.6,
      strokeTimeS: 40,
      display: { x: 980, y: 400 }
    },
    {
      kind: 'valve',
      id: 'V2',
      name: 'Задвижка сброса ЗД-2',
      fromNodeId: 'v2i',
      toNodeId: 'tank',
      diameterM: 0.15,
      characteristic: {
        opening: [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
        lossCoefficientK: [3000, 750, 160, 60, 28, 14, 7.5, 4.0, 2.0, 0.8, 0.3]
      },
      initialOpening: 0,
      strokeTimeS: 30,
      display: { x: 700, y: 540 }
    }
  ];
  const sp = specs(o.sensorProfile ?? 'high_rate');
  const sensors: SensorConfig[] = [
    sensor('PT-101', 'Давление С-1 (нефть)', 'pressure', { nodeId: 'sep1' }, sp.pb, 'boundary_input', 'sep1'),
    sensor('PT-102', 'Давление приёма Н-1', 'pressure', { nodeId: 'p1s' }, sp.p, 'residual'),
    sensor('PT-103', 'Давление нагнетания Н-1', 'pressure', { nodeId: 'p1d' }, sp.p, 'residual'),
    sensor('PT-104', 'Давление e2, 1600 м', 'pressure', { edgeId: 'e2', distanceM: 1600 }, sp.p, 'residual'),
    sensor('PT-105', 'Давление У-1', 'pressure', { nodeId: 'j1' }, sp.p, 'residual'),
    sensor('PT-106', 'Давление Куст-3', 'pressure', { nodeId: 'k3' }, sp.p, 'residual'),
    sensor('PT-107', 'Давление У-2', 'pressure', { nodeId: 'j2' }, sp.p, 'residual'),
    sensor('PT-108', 'Давление Куст-4', 'pressure', { nodeId: 'k4' }, sp.p, 'residual'),
    sensor('PT-109', 'Давление перед ЗД-1', 'pressure', { nodeId: 'v1i' }, sp.p, 'residual'),
    sensor('PT-110', 'Давление на входе УПН', 'pressure', { nodeId: 'upn' }, sp.pb, 'boundary_input', 'upn'),
    sensor('PT-111', 'Давление e4, 1400 м', 'pressure', { edgeId: 'e4', distanceM: 1400 }, sp.p, 'residual'),
    sensor('PT-112', 'Давление e6, 1200 м', 'pressure', { edgeId: 'e6', distanceM: 1200 }, sp.p, 'residual'),
    sensor('PT-113', 'Давление перед ЗД-2', 'pressure', { nodeId: 'v2i' }, sp.p, 'residual'),
    sensor('PT-201', 'Давление С-1 (вода)', 'pressure', { nodeId: 'sepw' }, sp.pb, 'boundary_input', 'sepw'),
    sensor('PT-202', 'Давление водовода, 450 м', 'pressure', { edgeId: 'e9', distanceM: 450 }, sp.p, 'residual'),
    sensor('PT-203', 'Давление водовода, 1350 м', 'pressure', { edgeId: 'e9', distanceM: 1350 }, sp.p, 'residual'),
    sensor('PT-204', 'Давление на приёме КНС', 'pressure', { nodeId: 'wout' }, sp.pb, 'boundary_input', 'wout'),
    sensor('FT-101', 'Расход после Н-1', 'massFlow', { edgeId: 'e2', distanceM: 50 }, sp.f, 'residual'),
    sensor('FT-102', 'Расход Куст-3', 'massFlow', { edgeId: 'e3', distanceM: 0 }, sp.f, 'boundary_input', 'k3'),
    sensor('FT-103', 'Расход Куст-4', 'massFlow', { edgeId: 'e5', distanceM: 0 }, sp.f, 'boundary_input', 'k4'),
    sensor('FT-104', 'Расход на УПН', 'massFlow', { edgeId: 'e7', distanceM: 250 }, sp.f, 'residual'),
    sensor('FT-105', 'Расход в линии сброса', 'massFlow', { edgeId: 'e8', distanceM: 780 }, sp.f, 'residual'),
    sensor('FT-201', 'Расход воды от С-1', 'massFlow', { edgeId: 'e9', distanceM: 20 }, sp.f, 'residual'),
    sensor('FT-202', 'Расход воды на КНС', 'massFlow', { edgeId: 'e9', distanceM: 1780 }, sp.f, 'residual'),
    sensor('TT-101', 'Температура С-1 (нефть)', 'temperature', { edgeId: 'e1', distanceM: 0 }, sp.t, 'boundary_input', 'sep1'),
    sensor('TT-102', 'Температура Куст-3', 'temperature', { edgeId: 'e3', distanceM: 0 }, sp.t, 'boundary_input', 'k3'),
    sensor('TT-103', 'Температура Куст-4', 'temperature', { edgeId: 'e5', distanceM: 0 }, sp.t, 'boundary_input', 'k4'),
    sensor('TT-104', 'Температура на входе УПН', 'temperature', { edgeId: 'e7', distanceM: 250 }, sp.t, 'residual'),
    sensor('TT-201', 'Температура воды С-1', 'temperature', { edgeId: 'e9', distanceM: 0 }, sp.t, 'boundary_input', 'sepw'),
    sensor('WC-101', 'Обводнённость С-1', 'waterFraction', { edgeId: 'e1', distanceM: 0 }, sp.w, 'boundary_input', 'sep1'),
    sensor('WC-102', 'Обводнённость Куст-3', 'waterFraction', { edgeId: 'e3', distanceM: 0 }, sp.w, 'boundary_input', 'k3'),
    sensor('WC-103', 'Обводнённость Куст-4', 'waterFraction', { edgeId: 'e5', distanceM: 0 }, sp.w, 'boundary_input', 'k4'),
    sensor('WC-104', 'Обводнённость на входе УПН', 'waterFraction', { edgeId: 'e7', distanceM: 250 }, sp.w, 'residual')
  ];
  const contextElements: ContextElement[] = [
    { id: 'pad1', kind: 'well_pad', name: 'Куст-1', position: { x: 70, y: 170 }, note: 'Источник продукции: контекст, пласт и скважины не моделируются', modelLevel: 'context_only' },
    { id: 'pad2', kind: 'well_pad', name: 'Куст-2', position: { x: 70, y: 470 }, note: 'Источник продукции: контекст, пласт и скважины не моделируются', modelLevel: 'context_only' },
    {
      id: 'gl1',
      kind: 'gas_liquid_line',
      name: 'Нефтегазосборный трубопровод Куст-1 → С-1',
      polyline: [{ x: 95, y: 175 }, { x: 170, y: 250 }, { x: 236, y: 330 }],
      note: 'Газосодержащий участок до сепарации: в M0 не рассчитывается; M1 — только акустический эксперимент',
      modelLevel: 'M1_acoustic_experiment'
    },
    {
      id: 'gl2',
      kind: 'gas_liquid_line',
      name: 'Нефтегазосборный трубопровод Куст-2 → С-1',
      polyline: [{ x: 95, y: 465 }, { x: 170, y: 410 }, { x: 236, y: 350 }],
      note: 'Газосодержащий участок до сепарации: в M0 не рассчитывается',
      modelLevel: 'context_only'
    },
    { id: 'sep', kind: 'separator', name: 'Сепаратор С-1 (первичная сепарация)', position: { x: 250, y: 345 }, note: 'P0: граница давления с заданным разделением потоков; уровень/давление аппарата не моделируются', modelLevel: 'context_only' },
    { id: 'gasline', kind: 'gas_line', name: 'Газ С-1 → выход газа', polyline: [{ x: 250, y: 320 }, { x: 250, y: 200 }, { x: 290, y: 120 }], note: 'Газовая линия: контекст', modelLevel: 'context_only' },
    { id: 'gasout', kind: 'gas_outlet', name: 'Газовый выход (ГПЗ / факел)', position: { x: 300, y: 105 }, note: 'Граничный узел, не рассчитывается', modelLevel: 'context_only' },
    { id: 'upnbox', kind: 'treatment', name: 'УПН (пункт подготовки нефти)', position: { x: 1135, y: 400 }, note: 'Граница давления; процесс подготовки не моделируется', modelLevel: 'context_only' },
    { id: 'kns', kind: 'water_injection', name: 'КНС (водный выход)', position: { x: 330, y: 700 }, note: 'Граница давления', modelLevel: 'context_only' }
  ];
  return {
    schemaVersion: SCHEMA_VERSION,
    id: o.id ?? 'demo_field',
    name: o.name ?? 'Условное месторождение: ДНС-1 → УПН',
    description:
      'Синтетическая сеть сбора жидкости после первичной сепарации: 9 рассчитываемых труб, насос, 2 задвижки, 2 куста с замером расхода, водовод на КНС. Газосодержащий участок — контекст.',
    fluidProfiles: [syntheticOilWater(), waterTabulated()],
    nodes,
    links,
    sensors,
    commands: o.commands ?? [],
    simulation: {
      targetReachLengthM: o.targetReachLengthM ?? 25,
      minReachesPerPipe: 6,
      transportCourant: 0.5,
      maxTransportIntervalS: 1,
      frictionModel: 'colebrook',
      propertyMode: 'fixed_acoustic_variable_viscosity',
      durationS: o.durationS ?? 900
    },
    contextElements,
    map: { width: 1200, height: 740 }
  };
}

export function defaultTruth(seed: number, events: TruthEvent[] = [], o: Partial<TruthConfig> = {}): TruthConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    seed,
    events,
    processNoise: { boundaryPressureStdPa: 2000, boundaryPressureTimeConstantS: 20, sourceFlowRelStd: 0.004, sourceFlowTimeConstantS: 30 },
    propertyDeviation: { viscosityFactor: 1.05, bulkModulusFactor: 0.98, roughnessFactor: 1.1 },
    ...o
  };
}

export function leak(eventId: string, edgeId: string, distanceM: number, startTimeS: number, holeDiameterM: number, openingDurationS = 0): TruthEvent {
  return { kind: 'leak', eventId, edgeId, distanceM, startTimeS, holeDiameterM, openingDurationS, dischargeCoefficient: 0.62, externalPressurePa: 101325, outflowModel: 'liquid_orifice' };
}

export function scenarioFile(
  id: string,
  name: string,
  description: string,
  expectedBehavior: string,
  pub: PublicScenarioConfig,
  truth: TruthConfig,
  tags: string[],
  limitations: string[] = []
): ScenarioFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    description,
    expectedBehavior,
    limitations: [
      'Синтетический объект и синтетические свойства среды; результаты не переносятся на реальное месторождение без калибровки.',
      'M0: фиксированные опорные rho и c по трубам; вязкость следует переносимым T и Y_w.',
      ...limitations
    ],
    tags,
    public: { ...pub, id: `${id}_public` },
    truth
  };
}
