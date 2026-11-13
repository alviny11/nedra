import type { PublicCommand } from '@pipetwin/contracts';
import type { ScenarioFile, TruthEvent } from '@pipetwin/contracts/truth';
import { RandomStream } from '@pipetwin/physics-core';
import { buildDemoPublic, defaultTruth, leak, scenarioFile, type SensorProfile } from './demoField';

/**
 * Random but physically admissible runs for dataset generation. Distributions are recorded in the
 * dataset manifest. Each run: normal warm-up (no events before 240 s), then at most one primary event
 * (and for held-out sets optionally a combination).
 */
export interface RandomSpec {
  durationS: number;
  sensorProfile: SensorProfile;
  kinds: Record<RunKind, number>;
  holeDiameterMM: [number, number];
  separatorTempC: [number, number];
  viscosityFactor: [number, number];
  roughnessFactor: [number, number];
  allowCombination: boolean;
}

export type RunKind = 'normal' | 'pump_change' | 'valve_change' | 'leak_abrupt' | 'leak_slow' | 'sensor_fault' | 'inlet_change';

export const DEFAULT_SPEC: RandomSpec = {
  durationS: 900,
  sensorProfile: 'high_rate',
  kinds: { normal: 0.14, pump_change: 0.12, valve_change: 0.1, leak_abrupt: 0.2, leak_slow: 0.14, sensor_fault: 0.15, inlet_change: 0.15 },
  holeDiameterMM: [6, 30],
  separatorTempC: [42, 55],
  viscosityFactor: [0.95, 1.12],
  roughnessFactor: [0.9, 1.3],
  allowCombination: false
};

export const OOD_SPEC: RandomSpec = {
  ...DEFAULT_SPEC,
  separatorTempC: [28, 36],
  viscosityFactor: [1.1, 1.25],
  roughnessFactor: [1.2, 1.5],
  sensorProfile: 'high_rate'
};

const LEAK_EDGES = ['e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9'];
const LENGTHS: Record<string, number> = { e2: 3200, e3: 2100, e4: 2800, e5: 1500, e6: 2400, e7: 300, e8: 800, e9: 1800 };
const DIAM: Record<string, number> = { e2: 0.259, e3: 0.15, e4: 0.309, e5: 0.125, e6: 0.309, e7: 0.309, e8: 0.207, e9: 0.15 };
/** hole <= 12 % of the bore keeps the run inside the liquid model (no gas release) in most cases */
const MAX_HOLE_TO_BORE = 0.12;
const RESIDUAL_SENSORS = ['PT-102', 'PT-103', 'PT-104', 'PT-105', 'PT-106', 'PT-107', 'PT-108', 'PT-109', 'PT-111', 'PT-112', 'PT-113', 'PT-202', 'PT-203', 'FT-101', 'FT-104'];

function pick<T>(r: RandomStream, xs: T[]): T {
  return xs[Math.floor(r.uniform() * xs.length)]!;
}

function uni(r: RandomStream, a: number, b: number): number {
  return a + (b - a) * r.uniform();
}

function pickKind(r: RandomStream, kinds: Record<RunKind, number>): RunKind {
  const tot = Object.values(kinds).reduce((s, v) => s + v, 0);
  let u = r.uniform() * tot;
  for (const [k, w] of Object.entries(kinds) as Array<[RunKind, number]>) {
    u -= w;
    if (u <= 0) return k;
  }
  return 'normal';
}

export function randomScenario(seed: number, spec: RandomSpec, idPrefix = 'ds'): { scenario: ScenarioFile; kind: RunKind } {
  const r = new RandomStream(seed, 'random-scenario');
  const kind = pickKind(r, spec.kinds);
  const commands: PublicCommand[] = [];
  // operating point variation (public, at t = 0)
  commands.push({ kind: 'pump_speed', id: 'init-p1', simTimeS: 0, targetId: 'P1', speedRatio: uni(r, 0.93, 1.0) });
  commands.push({ kind: 'valve_opening', id: 'init-v1', simTimeS: 0, targetId: 'V1', opening: uni(r, 0.5, 0.7) });
  const events: TruthEvent[] = [];
  const tEv = uni(r, 260, 560);
  switch (kind) {
    case 'pump_change': {
      const cur = commands[0]!.kind === 'pump_speed' ? (commands[0] as { speedRatio: number }).speedRatio : 1;
      const d = uni(r, 0.04, 0.1) * (r.uniform() < 0.6 ? -1 : 1);
      commands.push({ kind: 'pump_speed', id: 'cmd-p1', simTimeS: tEv, targetId: 'P1', speedRatio: Math.min(1.05, Math.max(0.82, cur + d)) });
      break;
    }
    case 'valve_change': {
      if (r.uniform() < 0.7) {
        const cur = (commands[1] as { opening: number }).opening;
        const d = uni(r, 0.08, 0.18) * (r.uniform() < 0.5 ? -1 : 1);
        commands.push({ kind: 'valve_opening', id: 'cmd-v1', simTimeS: tEv, targetId: 'V1', opening: Math.min(0.95, Math.max(0.35, cur + d)) });
      } else {
        commands.push({ kind: 'valve_opening', id: 'cmd-v2', simTimeS: tEv, targetId: 'V2', opening: uni(r, 0.15, 0.35) });
      }
      break;
    }
    case 'leak_abrupt':
    case 'leak_slow': {
      const e = pick(r, LEAK_EDGES);
      const L = LENGTHS[e]!;
      const dMax = Math.min(spec.holeDiameterMM[1], 1000 * MAX_HOLE_TO_BORE * DIAM[e]!);
      const d = Math.exp(uni(r, Math.log(spec.holeDiameterMM[0]), Math.log(Math.max(spec.holeDiameterMM[0] + 1, dMax)))) / 1000;
      const dist = uni(r, 0.06 * L, 0.94 * L);
      events.push(leak('leak-1', e, dist, tEv, d, kind === 'leak_slow' ? uni(r, 60, 300) : 0));
      break;
    }
    case 'sensor_fault': {
      const s = pick(r, RESIDUAL_SENSORS);
      const isP = s.startsWith('PT');
      const u = r.uniform();
      const sign = r.uniform() < 0.5 ? -1 : 1;
      const fault =
        u < 0.45
          ? { type: 'bias_step' as const, biasSI: sign * (isP ? uni(r, 8000, 40000) : uni(r, 1.5, 6)) }
          : u < 0.7
            ? { type: 'drift' as const, rateSIPerS: sign * (isP ? uni(r, 50, 300) : uni(r, 0.01, 0.05)) }
            : u < 0.85
              ? { type: 'stuck' as const }
              : { type: 'noise_increase' as const, factor: uni(r, 3, 8) };
      events.push({ kind: 'sensor_fault', eventId: 'fault-1', sensorId: s, startTimeS: tEv, fault });
      break;
    }
    case 'inlet_change': {
      if (r.uniform() < 0.5) events.push({ kind: 'inlet_change', eventId: 'inlet-1', nodeId: 'sep1', startTimeS: tEv, rampDurationS: uni(r, 30, 180), temperatureK: 273.15 + uni(r, 30, 40) });
      else events.push({ kind: 'inlet_change', eventId: 'inlet-1', nodeId: pick(r, ['k3', 'k4']), startTimeS: tEv, rampDurationS: uni(r, 30, 120), waterMassFraction: uni(r, 0.3, 0.42) });
      break;
    }
    case 'normal':
      break;
  }
  if (spec.allowCombination && (kind === 'sensor_fault' || kind === 'pump_change') && r.uniform() < 0.6) {
    const e = pick(r, LEAK_EDGES);
    // same bore limit as for single leaks (a 27 mm hole on the 125 mm line drove the run out of the liquid model)
    events.push(leak('leak-2', e, uni(r, 0.1, 0.9) * LENGTHS[e]!, Math.min(spec.durationS - 200, tEv + uni(r, 60, 200)), Math.min(uni(r, 0.012, 0.03), MAX_HOLE_TO_BORE * DIAM[e]!)));
  }
  const pub = buildDemoPublic({ sensorProfile: spec.sensorProfile, durationS: spec.durationS, commands });
  // separator temperature variation (public boundary passport value)
  const sepT = 273.15 + uni(r, spec.separatorTempC[0], spec.separatorTempC[1]);
  pub.nodes = pub.nodes.map((n) => (n.id === 'sep1' || n.id === 'sepw') && n.boundary ? { ...n, boundary: { ...n.boundary, temperatureK: sepT, pressurePa: uni(r, 4.0e5, 4.6e5) } } : n);
  const truth = defaultTruth(seed, events, {
    processNoise: { boundaryPressureStdPa: uni(r, 1000, 3000), boundaryPressureTimeConstantS: uni(r, 10, 40), sourceFlowRelStd: uni(r, 0.002, 0.006), sourceFlowTimeConstantS: uni(r, 15, 60) },
    propertyDeviation: { viscosityFactor: uni(r, spec.viscosityFactor[0], spec.viscosityFactor[1]), bulkModulusFactor: uni(r, 0.95, 1.03), roughnessFactor: uni(r, spec.roughnessFactor[0], spec.roughnessFactor[1]) }
  });
  const id = `${idPrefix}-${seed}`;
  return {
    scenario: scenarioFile(id, `${kind} #${seed}`, `random ${kind}`, 'generated', pub, truth, [kind]),
    kind
  };
}
