#!/usr/bin/env node
/**
 * PipeTwin headless runner: the SAME TypeScript physics and diagnostics as the browser, for batch work.
 *
 *   build-scenarios --out <repo-root>            write profiles, catalog scenarios, feature schema
 *   run --scenario <file.json|catalogId> --out <dir> [--model <artifact.json>] [--decimate 0.1]
 *   dataset --out <dir> --count N --seed S [--spec default|ood|heldout] [--workers-index i --workers-total k]
 *   benchmark --out <dir> [--suite catalog|<dir with scenario jsons>] [--model <artifact.json>] [--ids a,b]
 *   parity --model <artifact.json> --golden <golden.json>
 *   evaluate-runs --dirs <dataset dir>[,<dir>...] --out <dir>   event-level metrics of stored runs (no re-simulation)
 *   bench-hammer | bench-steady | bench-mesh | bench-perf --out <file.json>   verification benches
 *
 * Inputs are validated; outputs are plain JSON / JSONL / CSV. No network access.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LogisticModelArtifact, MeasurementSample, PublicScenarioConfig } from '@pipetwin/contracts';
import { SCHEMA_VERSION } from '@pipetwin/contracts';
import type { ScenarioFile } from '@pipetwin/contracts/truth';
import { validateScenario, PHYSICS_CORE_VERSION, buildTransientModel, compileProbe, evaluateProbe } from '@pipetwin/physics-core';
import { FEATURE_NAMES, FEATURE_SCHEMA, LogisticClassifier, DETECTOR_VERSION } from '@pipetwin/diagnostics-core';
import { evaluate, DEFAULT_PROTOCOL, type EvalRun } from '@pipetwin/evaluation';
import { allProfiles, waterVerification } from './scenarios/profiles';
import { buildCatalog } from './scenarios/catalog';
import { DEFAULT_SPEC, OOD_SPEC, randomScenario, type RandomSpec } from './scenarios/random';
import { runScenario, type RunResult } from './run';
import { TruthSimulator } from '@pipetwin/physics-core/truth';

function args(argv: string[]): { cmd: string; opts: Record<string, string> } {
  const [cmd = 'help', ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) opts[key] = 'true';
    else {
      opts[key] = v;
      i++;
    }
  }
  return { cmd, opts };
}

function writeJson(path: string, obj: unknown): void {
  writeFileSync(path, JSON.stringify(obj, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2));
}

function loadModel(path?: string): LogisticModelArtifact | null {
  if (!path) return null;
  const m = JSON.parse(readFileSync(path, 'utf8')) as LogisticModelArtifact;
  if (m.featureSchemaVersion !== FEATURE_SCHEMA.featureSchemaVersion) throw new Error(`MODEL_SCHEMA_MISMATCH: model ${m.featureSchemaVersion} vs runtime ${FEATURE_SCHEMA.featureSchemaVersion}`);
  if (m.featureNames.join(',') !== FEATURE_NAMES.join(',')) throw new Error('MODEL_SCHEMA_MISMATCH: feature names differ');
  return m;
}

function loadScenario(ref: string): ScenarioFile {
  let sc: ScenarioFile;
  if (existsSync(ref)) sc = JSON.parse(readFileSync(ref, 'utf8')) as ScenarioFile;
  else {
    const c = buildCatalog().find((s) => s.id === ref);
    if (!c) throw new Error(`unknown scenario ${ref}`);
    sc = c;
  }
  if (sc.schemaVersion !== SCHEMA_VERSION) throw new Error(`MODEL_SCHEMA_MISMATCH: scenario schema ${sc.schemaVersion}`);
  const v = validateScenario(sc.public);
  if (!v.ok) throw new Error(`INVALID_SCENARIO: ${v.errors.map((e) => `${e.code} ${e.message}`).join('; ')}`);
  return sc;
}

function measurementsCsv(ms: MeasurementSample[]): string {
  const lines = ['runId,sequence,sensorId,simTimeS,valueSI,quality,unit,measurementKind'];
  for (const m of ms) lines.push(`${m.runId},${m.sequence},${m.sensorId},${m.simTimeS.toFixed(4)},${m.valueSI === null ? '' : m.valueSI},${m.quality},${m.unit},${m.measurementKind}`);
  return lines.join('\n') + '\n';
}

function writeRun(dir: string, sc: ScenarioFile, r: RunResult, withMeasurements: boolean): void {
  mkdirSync(dir, { recursive: true });
  // diagnostician-visible artefacts
  writeJson(join(dir, 'meta.json'), {
    schemaVersion: SCHEMA_VERSION,
    runId: r.runId,
    scenarioId: sc.id,
    tags: sc.tags,
    durationS: r.simulatedS,
    wallMs: r.wallMs,
    physicsCoreVersion: PHYSICS_CORE_VERSION,
    detectorVersion: DETECTOR_VERSION,
    featureSchemaVersion: FEATURE_SCHEMA.featureSchemaVersion,
    modelVersion: r.modelVersion ?? null,
    commands: r.commands,
    engineStatus: r.engineStatus
  });
  writeFileSync(join(dir, 'features.jsonl'), r.features.map((f) => JSON.stringify({ runId: r.runId, simTimeS: f.simTimeS, ...Object.fromEntries(FEATURE_NAMES.map((n) => [n, Number.isFinite(f.features[n]) ? f.features[n] : null])) })).join('\n') + '\n');
  writeJson(join(dir, 'episodes.json'), r.episodes);
  writeJson(join(dir, 'status_log.json'), r.statusLog);
  writeJson(join(dir, 'final_diagnoses.json'), r.finalDiagnoses);
  if (withMeasurements && r.measurements) writeFileSync(join(dir, 'measurements.csv'), measurementsCsv(r.measurements));
  // evaluator-only artefact, separate file
  writeJson(join(dir, 'ground_truth.json'), r.truth);
}

function cmdBuildScenarios(opts: Record<string, string>): void {
  const root = resolve(opts.out ?? '.');
  mkdirSync(join(root, 'data/profiles'), { recursive: true });
  mkdirSync(join(root, 'data/scenarios'), { recursive: true });
  mkdirSync(join(root, 'packages/contracts/schemas'), { recursive: true });
  for (const p of allProfiles()) writeJson(join(root, 'data/profiles', `${p.id}.json`), p);
  const cat = buildCatalog();
  for (const sc of cat) {
    const v = validateScenario(sc.public);
    if (!v.ok) throw new Error(`catalog scenario ${sc.id} invalid: ${JSON.stringify(v.errors)}`);
    writeJson(join(root, 'data/scenarios', `${sc.id}.json`), sc);
  }
  writeJson(join(root, 'data/scenarios/index.json'), cat.map((s) => ({ id: s.id, name: s.name, description: s.description, expectedBehavior: s.expectedBehavior, tags: s.tags, durationS: s.public.simulation.durationS })));
  writeJson(join(root, 'packages/contracts/schemas/feature-schema.json'), FEATURE_SCHEMA);
  console.log(`wrote ${allProfiles().length} profiles, ${cat.length} scenarios, feature schema`);
}

function cmdRun(opts: Record<string, string>): void {
  const sc = loadScenario(opts.scenario ?? 'healthy_steady');
  const model = loadModel(opts.model);
  const runId = opts['run-id'] ?? `${sc.id}-${sc.truth.seed}`;
  const r = runScenario(sc, runId, { model, keepMeasurements: true, measurementDecimationS: Number(opts.decimate ?? '0.1') });
  writeRun(resolve(opts.out ?? `data/runs/${runId}`), sc, r, true);
  console.log(JSON.stringify({ runId, wallMs: Math.round(r.wallMs), episodes: r.episodes.length, final: Object.fromEntries(Object.entries(r.finalDiagnoses).map(([k, d]) => [k, `${d.status}/${d.cause}`])) }));
}

function specFor(name: string): RandomSpec {
  if (name === 'ood') return OOD_SPEC;
  if (name === 'heldout') return { ...DEFAULT_SPEC, allowCombination: true, kinds: { ...DEFAULT_SPEC.kinds, sensor_fault: 0.5, pump_change: 0.3, normal: 0.05, leak_abrupt: 0.05, leak_slow: 0.05, valve_change: 0.025, inlet_change: 0.025 } };
  if (name === 'lowrate') return { ...DEFAULT_SPEC, sensorProfile: 'low_rate' };
  return DEFAULT_SPEC;
}

function cmdDataset(opts: Record<string, string>): void {
  const out = resolve(opts.out ?? 'data/datasets/smoke');
  const count = Number(opts.count ?? '10');
  const seed0 = Number(opts.seed ?? '1000');
  const specName = opts.spec ?? 'default';
  const spec = specFor(specName);
  const wi = Number(opts['workers-index'] ?? '0');
  const wk = Number(opts['workers-total'] ?? '1');
  const model = loadModel(opts.model);
  mkdirSync(join(out, 'runs'), { recursive: true });
  const manifestPath = join(out, 'manifest.json');
  if (wi === 0) {
    writeJson(manifestPath, {
      schemaVersion: SCHEMA_VERSION,
      datasetId: opts.id ?? out.split('/').pop(),
      createdAt: new Date().toISOString(),
      count,
      seedStart: seed0,
      spec: specName,
      distributions: spec,
      featureSchema: FEATURE_SCHEMA,
      physicsCoreVersion: PHYSICS_CORE_VERSION,
      detectorVersion: DETECTOR_VERSION,
      warmupS: 180,
      labelPolicy:
        'Labels are derived later from ground_truth.json by the Python pipeline: leak (active and open), sensor_fault (active), operating_change (public command within the feature window), otherwise normal (hidden inlet temperature / composition changes are labelled normal).'
    });
  }
  for (let k = 0; k < count; k++) {
    if (k % wk !== wi) continue;
    const seed = seed0 + k;
    const { scenario, kind } = randomScenario(seed, spec, `${specName}`);
    const runId = `${specName}-${seed}`;
    const dir = join(out, 'runs', runId);
    if (existsSync(join(dir, 'ground_truth.json'))) continue;
    const r = runScenario(scenario, runId, { model });
    writeRun(dir, scenario, r, false);
    writeJson(join(dir, 'scenario.json'), scenario);
    console.log(`${runId} ${kind} ${(r.wallMs / 1000).toFixed(1)}s ${r.engineStatus}${r.truth.terminatedEarly ? ' TERMINATED ' + r.truth.terminatedEarly.code : ''}`);
  }
}

function cmdBenchmark(opts: Record<string, string>): void {
  const out = resolve(opts.out ?? 'data/benchmarks/latest');
  mkdirSync(out, { recursive: true });
  const model = loadModel(opts.model);
  let scenarios: ScenarioFile[];
  if (opts.suite && opts.suite !== 'catalog' && existsSync(opts.suite)) {
    scenarios = readdirSync(opts.suite)
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map((f) => loadScenario(join(opts.suite!, f)));
  } else scenarios = buildCatalog();
  if (opts.ids) {
    const ids = new Set(opts.ids.split(','));
    scenarios = scenarios.filter((s) => ids.has(s.id));
  }
  const runs: EvalRun[] = [];
  const perRun: unknown[] = [];
  for (const sc of scenarios) {
    const r = runScenario(sc, `${sc.id}-${sc.truth.seed}`, { model });
    writeRun(join(out, 'runs', r.runId), sc, r, false);
    runs.push({ runId: r.runId, scenarioId: sc.id, truth: r.truth, episodes: r.episodes, commands: r.commands, warmupS: 180, durationS: r.simulatedS, tags: sc.tags });
    perRun.push({ runId: r.runId, scenarioId: sc.id, wallS: r.wallMs / 1000, simS: r.simulatedS, final: Object.fromEntries(Object.entries(r.finalDiagnoses).map(([k, d]) => [k, { status: d.status, cause: d.cause, edges: d.candidateEdges.map((c) => c.edgeId), x: d.estimatedDistanceM, q: d.estimatedLeakMassFlowKgs }])) });
    console.log(`${sc.id}: ${(r.wallMs / 1000).toFixed(1)} s`);
  }
  const report = evaluate(runs, ['D0', 'D1', 'D2'], DEFAULT_PROTOCOL);
  writeJson(join(out, 'evaluation_report.json'), { ...report, model: model ? { modelVersion: model.modelVersion } : null, perRun });
  console.log(JSON.stringify(report.detectors.map((d) => ({ det: d.detector, recall: d.recall, fah: d.falseAlarmsPerHour, latMed: d.latencyMedianS, edgeAcc: d.edgeAccuracy, dErrMed: d.distanceErrorMedianM })), null, 1));
}

/** evaluate already generated runs (episodes + separate ground truth) without re-simulating */
function cmdEvaluateRuns(opts: Record<string, string>): void {
  const dirs = (opts.dirs ?? opts.dir ?? '').split(',').filter(Boolean);
  const runs: EvalRun[] = [];
  let model: string | null = null;
  for (const d of dirs) {
    const base = join(resolve(d), 'runs');
    for (const r of readdirSync(base).sort()) {
      const p = join(base, r);
      if (!existsSync(join(p, 'ground_truth.json')) || !existsSync(join(p, 'episodes.json'))) continue;
      const truth = JSON.parse(readFileSync(join(p, 'ground_truth.json'), 'utf8'));
      const meta = JSON.parse(readFileSync(join(p, 'meta.json'), 'utf8'));
      const sc = existsSync(join(p, 'scenario.json')) ? JSON.parse(readFileSync(join(p, 'scenario.json'), 'utf8')) : null;
      runs.push({ runId: r, scenarioId: meta.scenarioId, truth, episodes: JSON.parse(readFileSync(join(p, 'episodes.json'), 'utf8')), commands: meta.commands, warmupS: 180, durationS: truth.durationS, tags: sc?.tags ?? meta.tags });
      model = meta.modelVersion ?? model;
    }
  }
  const report = evaluate(runs, ['D0', 'D1', 'D2'], DEFAULT_PROTOCOL);
  const out = resolve(opts.out ?? 'data/benchmarks/latest');
  mkdirSync(out, { recursive: true });
  writeJson(join(out, 'evaluation_report.json'), { ...report, suite: dirs.map((d) => d.split('/').pop()).join('+'), model: model ? { modelVersion: model } : null });
  console.log(JSON.stringify(report.detectors.map((d) => ({ det: d.detector, recall: d.recall, fah: d.falseAlarmsPerHour, latMed: d.latencyMedianS, edgeAcc: d.edgeAccuracy, dErrMed: d.distanceErrorMedianM, f1: d.causeMacroF1 })), null, 1));
}

function cmdParity(opts: Record<string, string>): void {
  const model = loadModel(opts.model);
  if (!model) throw new Error('--model required');
  const golden = JSON.parse(readFileSync(opts.golden!, 'utf8')) as { X: Array<Array<number | null>>; proba: number[][] };
  const clf = new LogisticClassifier(model);
  let maxDiff = 0;
  golden.X.forEach((row, i) => {
    const p = clf.predictProba(row.map((v) => (v === null ? Number.NaN : v)));
    p.forEach((v, k) => (maxDiff = Math.max(maxDiff, Math.abs(v - golden.proba[i]![k]!))));
  });
  console.log(JSON.stringify({ rows: golden.X.length, maxAbsDiff: maxDiff, ok: maxDiff < 1e-9 }));
  if (maxDiff >= 1e-9) process.exitCode = 1;
}

/** water-hammer verification case for the independent Python MOC / analytic checks */
function cmdBenchHammer(opts: Record<string, string>): void {
  const reach = Number(opts.reach ?? '10');
  const water = waterVerification();
  const cfg = benchPublic(
    [
      { id: 'R', name: 'R', kind: 'pressure_boundary', role: 'junction', elevationM: 0, display: { x: 0, y: 0 }, boundary: { pressurePa: 10e5, temperatureK: 293.15, waterMassFraction: 1 } },
      { id: 'V', name: 'V', kind: 'junction', role: 'valve_port', elevationM: 0, display: { x: 1, y: 0 } },
      { id: 'O', name: 'O', kind: 'pressure_boundary', role: 'junction', elevationM: 0, display: { x: 2, y: 0 }, boundary: { pressurePa: 10e5 - 1500, temperatureK: 293.15, waterMassFraction: 1 } }
    ],
    [benchPipe('p', 'R', 'V', 1200, 0.3, 0, 0, water.id), { kind: 'valve', id: 'v', name: 'v', fromNodeId: 'V', toNodeId: 'O', diameterM: 0.3, characteristic: { opening: [0.1, 0.3, 0.5, 0.7, 1.0], lossCoefficientK: [400, 30, 8, 2.5, 0.5] }, initialOpening: 1, strokeTimeS: 0, display: { x: 1, y: 0 } }],
    [water],
    reach
  );
  const { model, net } = buildTransientModel(cfg, { viscosityMode: 'transported', transport: false });
  const pp = net.pipes[0]!;
  const probe = compileProbe(net, { id: 's', name: 's', kind: 'pressure', edgeId: 'p', distanceM: 300, sampleRateHz: 100, timeConstantS: 0, delayS: 0, noiseStdSI: 0, biasSI: 0, quantizationStepSI: 0, dropoutProbability: 0, timestampJitterS: 0, rangeSI: [0, 1e8], role: 'residual', availability: 'online' });
  const u0 = model.uR[pp.offset + pp.n]!;
  const out = { L: pp.L, D: pp.D, c: pp.c, rho: pp.rho, u0, dt: model.dt, reaches: pp.n, pR: 10e5, pValve0: model.p[pp.offset + pp.n]!, xSensor: 300, t: [] as number[], pValve: [] as number[], pSensor: [] as number[] };
  model.valveCommand[0] = 0;
  while (model.t < 4.5 * (pp.L / pp.c)) {
    model.step();
    out.t.push(model.t);
    out.pValve.push(model.p[pp.offset + pp.n]!);
    out.pSensor.push(evaluateProbe(model, probe));
  }
  writeJson(resolve(opts.out ?? 'bench-hammer.json'), out);
  console.log(JSON.stringify({ c: pp.c, u0, steps: out.t.length }));
}

/** small looped water network for the EPANET (WNTR) comparison */
function cmdBenchSteady(opts: Record<string, string>): void {
  const water = waterVerification();
  const rho = 1000;
  const g = 9.80665;
  const pAbs = (H: number, z: number): number => 101325 + rho * g * (H - z);
  const N = (id: string, kind: 'junction' | 'pressure_boundary' | 'mass_flow_source', z: number, b?: { pressurePa?: number; massFlowKgS?: number }) => ({
    id,
    name: id,
    kind,
    role: 'junction' as const,
    elevationM: z,
    display: { x: 0, y: 0 },
    boundary: b ? { temperatureK: 293.15, waterMassFraction: 1, ...b } : undefined
  });
  const cfg = benchPublic(
    [N('R1', 'pressure_boundary', 0, { pressurePa: pAbs(60, 0) }), N('R2', 'pressure_boundary', 0, { pressurePa: pAbs(30, 0) }), N('J1', 'junction', 5), N('J2', 'junction', 8), N('J3', 'junction', 10), N('S', 'mass_flow_source', 3, { massFlowKgS: 15 })],
    [
      benchPipe('P1', 'R1', 'J1', 1000, 0.3, 0, 5, water.id),
      benchPipe('P2', 'J1', 'J2', 800, 0.25, 5, 8, water.id),
      benchPipe('P3', 'J2', 'R2', 1200, 0.2, 8, 0, water.id),
      benchPipe('P4', 'J1', 'J3', 600, 0.2, 5, 10, water.id),
      benchPipe('P5', 'J3', 'J2', 700, 0.2, 10, 8, water.id),
      benchPipe('P6', 'S', 'J3', 500, 0.15, 3, 10, water.id)
    ],
    [water],
    25
  );
  const { steady, net } = buildTransientModel(cfg, { viscosityMode: 'transported', transport: false });
  const heads: Record<string, number> = {};
  net.nodes.forEach((n, i) => (heads[n.id] = n.z + (steady.nodeP[i]! - 101325) / (net.pipes[n.ends[0]!.pipe]!.rho * g)));
  const flows: Record<string, number> = {};
  net.pipes.forEach((p, i) => (flows[p.id] = steady.pipeMassFlow[i]! / p.rho));
  writeJson(resolve(opts.out ?? 'bench-steady.json'), { headsM: heads, flowsM3S: flows, roughnessM: 4.5e-5, viscosityM2S: 1e-6, network: cfg });
  console.log(JSON.stringify({ heads, flows }));
}

function benchPipe(id: string, from: string, to: string, L: number, D: number, z0: number, z1: number, fluid: string) {
  return {
    kind: 'pipe' as const,
    id,
    name: id,
    fromNodeId: from,
    toNodeId: to,
    lengthM: L,
    innerDiameterM: D,
    wallThicknessM: 0.01,
    roughnessM: 4.5e-5,
    youngModulusPa: 2e11,
    poissonRatio: 0.3,
    restraintModel: 'expansion_joints' as const,
    elevationProfile: [
      { distanceM: 0, elevationM: z0 },
      { distanceM: L, elevationM: z1 }
    ],
    displayPolyline: [
      { x: 0, y: 0 },
      { x: 1, y: 1 }
    ],
    thermal: { overallHeatTransferWm2K: 0, referenceOuterDiameterM: D + 0.02, ambientTemperatureK: 293.15, insulation: 'none' },
    fluidProfileId: fluid,
    solverModel: 'M0_liquid_moc' as const
  };
}

function benchPublic(nodes: PublicScenarioConfig['nodes'], links: PublicScenarioConfig['links'], fluids: PublicScenarioConfig['fluidProfiles'], reach: number): PublicScenarioConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'bench',
    name: 'bench',
    description: 'verification bench',
    fluidProfiles: fluids,
    nodes,
    links,
    sensors: [],
    commands: [],
    simulation: { targetReachLengthM: reach, minReachesPerPipe: 4, transportCourant: 0.5, maxTransportIntervalS: 1, frictionModel: 'colebrook', propertyMode: 'fixed_acoustic_variable_viscosity', durationS: 60 },
    contextElements: [],
    map: { width: 1, height: 1 }
  };
}

/** N, 2N, 4N study on the demo field: leak-induced pressure change and leak flow, plus cost */
function cmdBenchMesh(opts: Record<string, string>): void {
  const sc = buildCatalog().find((x) => x.id === 'leak_abrupt_e4')!;
  const quiet: ScenarioFile = { ...sc, truth: { ...sc.truth, processNoise: { boundaryPressureStdPa: 0, boundaryPressureTimeConstantS: 20, sourceFlowRelStd: 0, sourceFlowTimeConstantS: 30 } } };
  const rows: unknown[] = [];
  for (const reach of [50, 25, 12.5]) {
    const sim = new TruthSimulator(quiet, `mesh-${reach}`, { targetReachLengthM: reach });
    const probe = compileProbe(sim.net, quiet.public.sensors.find((s) => s.id === 'PT-111')!);
    const probe2 = compileProbe(sim.net, quiet.public.sensors.find((s) => s.id === 'PT-109')!);
    sim.advanceTo(419.5);
    const p0 = evaluateProbe(sim.model, probe);
    const p0b = evaluateProbe(sim.model, probe2);
    const t0 = performance.now();
    sim.advanceTo(422);
    const dp2 = evaluateProbe(sim.model, probe) - p0;
    sim.advanceTo(480);
    const wall = performance.now() - t0;
    const dpss = evaluateProbe(sim.model, probe2) - p0b;
    rows.push({ targetReachM: reach, points: sim.net.nPoints, dtS: sim.model.dt, dpAtPT111After2sPa: dp2, dpAtPT109After60sPa: dpss, leakKgS: sim.snapshot().leaks[0]!.massFlowKgS, wallMsPerSimS: wall / 60.5 });
  }
  const r = rows as Array<{ dpAtPT111After2sPa: number; leakKgS: number; dpAtPT109After60sPa: number }>;
  const rel = (a: number, b: number): number => Math.abs(a / b - 1);
  const out = { rows, lastTwoRelDiff: { dp2s: rel(r[2]!.dpAtPT111After2sPa, r[1]!.dpAtPT111After2sPa), dp60s: rel(r[2]!.dpAtPT109After60sPa, r[1]!.dpAtPT109After60sPa), leak: rel(r[2]!.leakKgS, r[1]!.leakKgS) } };
  writeJson(resolve(opts.out ?? 'bench-mesh.json'), out);
  console.log(JSON.stringify(out, null, 1));
}

/** throughput of truth + two observers + detectors on the demo field */
function cmdBenchPerf(opts: Record<string, string>): void {
  const sc = buildCatalog().find((x) => x.id === 'healthy_steady')!;
  const dur = Number(opts.seconds ?? '300');
  const short: ScenarioFile = { ...sc, public: { ...sc.public, simulation: { ...sc.public.simulation, durationS: dur } } };
  const t0 = performance.now();
  const sim = new TruthSimulator(short, 'perf');
  const tInit = performance.now() - t0;
  const t1 = performance.now();
  let samples = 0;
  for (let t = 0.5; t <= dur; t += 0.5) samples += sim.advanceTo(t).length;
  const truthMs = performance.now() - t1;
  const r = runScenario(short, 'perf2');
  const out = { points: sim.net.nPoints, cells: sim.net.nCells, dtS: sim.model.dt, stepsPerSimSecond: 1 / sim.model.dt, initMs: tInit, truthOnly: { simSecondsPerWallSecond: dur / (truthMs / 1000), samplesPerSimSecond: samples / dur }, truthPlusDiagnostics: { simSecondsPerWallSecond: dur / (r.wallMs / 1000) }, node: process.version, cpu: (await_cpu()) };
  writeJson(resolve(opts.out ?? 'bench-perf.json'), out);
  console.log(JSON.stringify(out, null, 1));
}

function await_cpu(): string {
  try {
    return readFileSync('/proc/cpuinfo', 'utf8').split('\n').find((l) => l.startsWith('model name'))?.split(':')[1]?.trim() ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function main(): void {
  const { cmd, opts } = args(process.argv.slice(2));
  switch (cmd) {
    case 'build-scenarios':
      return cmdBuildScenarios(opts);
    case 'run':
      return cmdRun(opts);
    case 'dataset':
      return cmdDataset(opts);
    case 'benchmark':
      return cmdBenchmark(opts);
    case 'parity':
      return cmdParity(opts);
    case 'evaluate-runs':
      return cmdEvaluateRuns(opts);
    case 'bench-mesh':
      return cmdBenchMesh(opts);
    case 'bench-perf':
      return cmdBenchPerf(opts);
    case 'bench-hammer':
      return cmdBenchHammer(opts);
    case 'bench-steady':
      return cmdBenchSteady(opts);
    default:
      console.log('commands: build-scenarios | run | dataset | benchmark | parity | evaluate-runs | bench-hammer | bench-steady | bench-mesh | bench-perf  (see header of src/cli.ts)');
  }
}

try {
  main();
} catch (e) {
  console.error(JSON.stringify({ code: (e as { code?: string }).code ?? 'RUNNER_ERROR', message: (e as Error).message }));
  process.exitCode = 2;
}
