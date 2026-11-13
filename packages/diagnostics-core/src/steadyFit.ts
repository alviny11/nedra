import type { CandidateEdge, SensorConfig } from '@pipetwin/contracts';
import {
  G,
  pipeLoss,
  profileAt,
  solveHydraulics,
  valveLossCoefficient,
  type CompiledNetwork,
  type HydLink,
  type HydNode,
  type TransientNetwork
} from '@pipetwin/physics-core';

/**
 * Slow-leak localisation as a small inverse problem: for candidate positions on PUBLIC edges, the
 * observer's own steady model (current measured boundary conditions, its own viscosity field) is
 * solved with a hypothetical withdrawal; the predicted change of sensor readings is fitted to the
 * observed change of residuals. This is a diagnostic hypothesis with its own simulation, not truth.
 */

export interface SteadyFitResult {
  timeS: number;
  candidates: CandidateEdge[];
  best?: { edgeId: string; distanceM: number; misfit: number; leakKgS: number };
  usedSensorIds: string[];
  note: string;
}

const SEG = 8;

interface OperatingPoint {
  bcP: Float64Array;
  bcM: Float64Array;
  pump: Float64Array;
  valve: Float64Array;
  cellMu: Float64Array;
}

export function operatingPointFrom(model: TransientNetwork): OperatingPoint {
  const net = model.net;
  const cellMu = new Float64Array(net.nCells);
  for (const pp of net.pipes) {
    for (let k = 0; k < pp.n; k++) cellMu[pp.cellOffset + k] = 0.5 * (model.nuPt[pp.offset + k]! + model.nuPt[pp.offset + k + 1]!) * pp.rho;
  }
  return { bcP: model.bcPressure.slice(), bcM: model.bcMassFlow.slice(), pump: model.pumpSpeed.slice(), valve: model.valveOpening.slice(), cellMu };
}

type PipeLink = Extract<HydLink, { kind: 'pipe' }>;

function lumpSegments(net: CompiledNetwork, j: number, x0: number, x1: number, op: OperatingPoint): { len: Float64Array; mu: Float64Array } {
  const pp = net.pipes[j]!;
  const lens: number[] = [];
  const mus: number[] = [];
  const total = x1 - x0;
  const nSeg = Math.max(1, Math.min(SEG, Math.ceil(total / pp.dx)));
  const h = total / nSeg;
  for (let s = 0; s < nSeg; s++) {
    const a = x0 + s * h;
    const b = a + h;
    // average viscosity of the cells overlapping [a,b]
    let wsum = 0;
    let msum = 0;
    const k0 = Math.max(0, Math.floor(a / pp.dx));
    const k1 = Math.min(pp.n - 1, Math.floor((b - 1e-9) / pp.dx));
    for (let k = k0; k <= k1; k++) {
      const ca = Math.max(a, k * pp.dx);
      const cb = Math.min(b, (k + 1) * pp.dx);
      const w = Math.max(0, cb - ca);
      wsum += w;
      msum += w * op.cellMu[pp.cellOffset + k]!;
    }
    lens.push(h);
    mus.push(wsum > 0 ? msum / wsum : op.cellMu[pp.cellOffset + k0]!);
  }
  return { len: new Float64Array(lens), mu: new Float64Array(mus) };
}

interface HydModel {
  nodes: HydNode[];
  links: HydLink[];
  /** for each pipe: link parts [{link index, x0, x1}] */
  parts: Array<Array<{ link: number; x0: number; x1: number }>>;
}

function buildHyd(net: CompiledNetwork, op: OperatingPoint, split?: { pipe: number; x: number; q: number }): HydModel {
  const nodes: HydNode[] = net.nodes.map((nd, i) => ({
    fixedPressurePa: nd.kind === 'pressure' ? op.bcP[i]! : undefined,
    injectionKgS: nd.kind === 'source' ? op.bcM[i]! : 0,
    elevationM: nd.z
  }));
  const links: HydLink[] = [];
  const parts: HydModel['parts'] = net.pipes.map(() => []);
  const mkPipe = (j: number, from: number, to: number, x0: number, x1: number, zf: number, zt: number): PipeLink => {
    const pp = net.pipes[j]!;
    const s = lumpSegments(net, j, x0, x1, op);
    return {
      kind: 'pipe',
      from,
      to,
      rho: pp.rho,
      A: pp.A,
      D: pp.D,
      relRough: pp.relRough,
      L: x1 - x0,
      localK: pp.localK * ((x1 - x0) / pp.L),
      segLen: s.len,
      segMu: s.mu,
      zFrom: zf,
      zTo: zt,
      frictionModel: net.settings.frictionModel
    };
  };
  for (const pp of net.pipes) {
    const zf = net.zPt[pp.offset]!;
    const zt = net.zPt[pp.offset + pp.n]!;
    if (split && split.pipe === pp.index) {
      const zx = profileAt(pp.cfg.elevationProfile, split.x);
      const xi = nodes.length;
      nodes.push({ injectionKgS: -split.q, elevationM: zx });
      parts[pp.index]!.push({ link: links.length, x0: 0, x1: split.x });
      links.push(mkPipe(pp.index, pp.from, xi, 0, split.x, zf, zx));
      parts[pp.index]!.push({ link: links.length, x0: split.x, x1: pp.L });
      links.push(mkPipe(pp.index, xi, pp.to, split.x, pp.L, zx, zt));
    } else {
      parts[pp.index]!.push({ link: links.length, x0: 0, x1: pp.L });
      links.push(mkPipe(pp.index, pp.from, pp.to, 0, pp.L, zf, zt));
    }
  }
  for (const d of net.devices) {
    if (d.kind === 'pump') links.push({ kind: 'pump', from: d.from, to: d.to, rho: d.rho, curve: d.curve!, speedRatio: op.pump[d.index]!, checkValve: d.pump!.checkValve });
    else links.push({ kind: 'valve', from: d.from, to: d.to, rho: d.rho, A: d.areaM2, K: valveLossCoefficient(d.valve!, op.valve[d.index]!) });
  }
  return { nodes, links, parts };
}

/** sensor readings from a steady solution */
function readSensors(net: CompiledNetwork, hm: HydModel, sol: { massFlow: Float64Array; pressure: Float64Array }, sensors: SensorConfig[]): number[] {
  return sensors.map((s) => {
    if (s.nodeId) return sol.pressure[net.nodeIndex.get(s.nodeId)!]!;
    const j = net.pipeIndex.get(s.edgeId ?? '');
    if (j === undefined) return Number.NaN;
    const pp = net.pipes[j]!;
    const d = s.distanceM ?? 0;
    const part = hm.parts[j]!.find((pt) => d >= pt.x0 - 1e-9 && d <= pt.x1 + 1e-9)!;
    const lk = hm.links[part.link] as PipeLink;
    const m = sol.massFlow[part.link]!;
    if (s.kind === 'massFlow') return m;
    if (s.kind === 'volumeFlow') return m / pp.rho;
    if (s.kind !== 'pressure') return Number.NaN;
    const pFrom = sol.pressure[lk.from]!;
    const dl = d - part.x0;
    const frac = lk.L > 0 ? dl / lk.L : 0;
    const [loss] = pipeLoss(lk, m);
    const z = profileAt(pp.cfg.elevationProfile, d);
    return pFrom - pp.rho * G * (z - lk.zFrom) - loss * frac;
  });
}

export function steadySensitivityFit(
  net: CompiledNetwork,
  model: TransientNetwork,
  sensors: SensorConfig[],
  deltaResidual: number[],
  weights: number[],
  opts: { coarseStepM: number; fineStepM: number; timeS: number; leakPriorKgS?: number; leakPriorSigmaKgS?: number }
): SteadyFitResult {
  const op = operatingPointFrom(model);
  const base = buildHyd(net, op);
  let baseSol;
  try {
    baseSol = solveHydraulics(base.nodes, base.links);
  } catch {
    return { timeS: opts.timeS, candidates: [], usedSensorIds: [], note: 'Стационарная модель наблюдателя не сошлась в текущей рабочей точке.' };
  }
  const v0 = readSensors(net, base, baseSol, sensors);
  const q0 = Math.max(1, opts.leakPriorKgS ?? 1);
  const evalCand = (pipe: number, x: number): { J: number; q: number } | null => {
    const hm = buildHyd(net, op, { pipe, x, q: q0 });
    let sol;
    try {
      sol = solveHydraulics(hm.nodes, hm.links, { initialMassFlow: undefined });
    } catch {
      return null;
    }
    const v = readSensors(net, hm, sol, sensors);
    let num = 0;
    let den = 0;
    const s: number[] = [];
    for (let i = 0; i < sensors.length; i++) {
      const si = (v[i]! - v0[i]!) / q0;
      s.push(si);
      if (!Number.isFinite(deltaResidual[i]!) || !Number.isFinite(si)) continue;
      num += weights[i]! * si * deltaResidual[i]!;
      den += weights[i]! * si * si;
    }
    // optional prior from the integral mass balance (q ~ leak mass flow)
    if (opts.leakPriorKgS !== undefined && opts.leakPriorSigmaKgS) {
      const wq = 1 / (opts.leakPriorSigmaKgS * opts.leakPriorSigmaKgS);
      num += wq * opts.leakPriorKgS;
      den += wq;
    }
    const q = den > 0 ? Math.max(0, num / den) : 0;
    let J = 0;
    for (let i = 0; i < sensors.length; i++) {
      if (!Number.isFinite(deltaResidual[i]!) || !Number.isFinite(s[i]!)) continue;
      const r = deltaResidual[i]! - q * s[i]!;
      J += weights[i]! * r * r;
    }
    if (opts.leakPriorKgS !== undefined && opts.leakPriorSigmaKgS) J += ((q - opts.leakPriorKgS) / opts.leakPriorSigmaKgS) ** 2;
    return { J, q };
  };
  const results = new Map<number, Array<{ x: number; J: number; q: number }>>();
  for (const pp of net.pipes) {
    const n = Math.max(2, Math.ceil(pp.L / opts.coarseStepM));
    const arr: Array<{ x: number; J: number; q: number }> = [];
    for (let k = 1; k < n; k++) {
      const x = (k * pp.L) / n;
      const r = evalCand(pp.index, x);
      if (r) arr.push({ x, ...r });
    }
    results.set(pp.index, arr);
  }
  // refine top edges
  const edgeBest = [...results.entries()]
    .filter(([, a]) => a.length)
    .map(([j, a]) => ({ j, best: a.reduce((m, c) => (c.J < m.J ? c : m)) }))
    .sort((a, b) => a.best.J - b.best.J);
  for (const e of edgeBest.slice(0, 3)) {
    const pp = net.pipes[e.j]!;
    const step = pp.L / Math.max(2, Math.ceil(pp.L / opts.coarseStepM));
    const lo = Math.max(opts.fineStepM, e.best.x - 2 * step);
    const hi = Math.min(pp.L - opts.fineStepM, e.best.x + 2 * step);
    for (let x = lo; x <= hi; x += opts.fineStepM) {
      const r = evalCand(e.j, x);
      if (r) results.get(e.j)!.push({ x, ...r });
    }
  }
  let gJ = Number.POSITIVE_INFINITY;
  let gBest: { edgeId: string; distanceM: number; misfit: number; leakKgS: number } | undefined;
  for (const [j, arr] of results) for (const c of arr) if (c.J < gJ) {
    gJ = c.J;
    gBest = { edgeId: net.pipes[j]!.id, distanceM: c.x, misfit: c.J, leakKgS: c.q };
  }
  if (!gBest) return { timeS: opts.timeS, candidates: [], usedSensorIds: sensors.map((s) => s.id), note: 'Кандидаты не рассчитаны.' };
  const delta = Math.max(4, 0.1 * gJ);
  const cands: CandidateEdge[] = [];
  let supSum = 0;
  for (const [j, arr] of results) {
    const adm = arr.filter((c) => c.J <= gJ + delta);
    if (!adm.length) continue;
    const best = adm.reduce((m, c) => (c.J < m.J ? c : m));
    const sup = Math.exp(-0.5 * (best.J - gJ));
    supSum += sup;
    cands.push({
      edgeId: net.pipes[j]!.id,
      misfit: best.J,
      support: sup,
      estimatedDistanceM: best.x,
      intervalM: [Math.min(...adm.map((c) => c.x)), Math.max(...adm.map((c) => c.x))],
      method: 'steady_residual_fit'
    });
  }
  cands.sort((a, b) => a.misfit - b.misfit);
  for (const c of cands) c.support /= supSum;
  return {
    timeS: opts.timeS,
    candidates: cands.slice(0, 4),
    best: gBest,
    usedSensorIds: sensors.map((s) => s.id),
    note: cands.length > 1 ? 'Подбор по невязкам допускает несколько рёбер.' : 'Подбор по невязкам указывает одно ребро.'
  };
}
