import type { CandidateEdge, SensorConfig } from '@pipetwin/contracts';
import type { CompiledNetwork } from '@pipetwin/physics-core';

/**
 * Wave-arrival localisation on the PUBLIC topology. Travel times follow physically connected paths:
 * pipes (L/c, corrected by the mean flow), running pumps and open valves pass waves; closed valves,
 * pressure boundaries (separator, treatment unit, tanks) do not. A shortest-time search is a
 * candidate generator for first arrivals only, not a proof of the full wave pattern.
 */

export interface Onset {
  sensorId: string;
  tS: number;
  amplitude: number;
  sigmaS: number;
}

export interface WaveLocalization {
  timeS: number;
  onsets: Onset[];
  best?: { edgeId: string; distanceM: number; misfit: number; t0S: number };
  candidates: CandidateEdge[];
  ambiguous: boolean;
  note: string;
}

export function nodeTravelTimes(net: CompiledNetwork, valveOpen: (devIdx: number) => boolean): Float64Array {
  const nN = net.nodes.length;
  const D = new Float64Array(nN * nN).fill(Number.POSITIVE_INFINITY);
  const adj: Array<Array<[number, number]>> = net.nodes.map(() => []);
  for (const p of net.pipes) {
    const w = p.L / p.c;
    adj[p.from]!.push([p.to, w]);
    adj[p.to]!.push([p.from, w]);
  }
  for (const d of net.devices) {
    if (d.kind === 'valve' && !valveOpen(d.index)) continue;
    adj[d.from]!.push([d.to, 0]);
    adj[d.to]!.push([d.from, 0]);
  }
  for (let s = 0; s < nN; s++) {
    const dist = new Float64Array(nN).fill(Number.POSITIVE_INFINITY);
    const done = new Uint8Array(nN);
    dist[s] = 0;
    for (let it = 0; it < nN; it++) {
      let u = -1;
      let best = Number.POSITIVE_INFINITY;
      for (let k = 0; k < nN; k++) if (!done[k] && dist[k]! < best) {
        best = dist[k]!;
        u = k;
      }
      if (u < 0) break;
      done[u] = 1;
      // waves are not transmitted through fixed-pressure boundaries
      if (u !== s && net.nodes[u]!.kind === 'pressure') continue;
      for (const [v, w] of adj[u]!) if (dist[u]! + w < dist[v]!) dist[v] = dist[u]! + w;
    }
    for (let k = 0; k < nN; k++) D[s * nN + k] = dist[k]!;
  }
  return D;
}

interface SensorLoc {
  sensorId: string;
  node?: number;
  pipe?: number;
  x?: number;
}

export function sensorLocations(net: CompiledNetwork, sensors: SensorConfig[]): SensorLoc[] {
  return sensors.map((s) => {
    if (s.nodeId) return { sensorId: s.id, node: net.nodeIndex.get(s.nodeId) };
    return { sensorId: s.id, pipe: net.pipeIndex.get(s.edgeId ?? ''), x: s.distanceM ?? 0 };
  });
}

/** first-arrival travel time from a point (pipe, x) to a sensor */
export function travelTime(net: CompiledNetwork, D: Float64Array, pipe: number, x: number, loc: SensorLoc): number {
  const nN = net.nodes.length;
  const pp = net.pipes[pipe]!;
  const toFrom = x / pp.c;
  const toTo = (pp.L - x) / pp.c;
  const fromNode = (n: number): number => Math.min(toFrom + D[pp.from * nN + n]!, toTo + D[pp.to * nN + n]!);
  if (loc.node !== undefined) {
    if (loc.node === pp.from) return Math.min(toFrom, toTo + D[pp.to * nN + loc.node]!);
    if (loc.node === pp.to) return Math.min(toTo, toFrom + D[pp.from * nN + loc.node]!);
    return fromNode(loc.node);
  }
  if (loc.pipe === undefined) return Number.POSITIVE_INFINITY;
  const q = net.pipes[loc.pipe]!;
  const y = loc.x ?? 0;
  let t = Math.min(fromNode(q.from) + y / q.c, fromNode(q.to) + (q.L - y) / q.c);
  if (loc.pipe === pipe) t = Math.min(t, Math.abs(x - y) / pp.c);
  return t;
}

/** straight homogeneous pipe between two sensors: x from the left sensor = (L + c (tL - tR)) / 2 */
export function straightPipeEstimate(L: number, c: number, tLeft: number, tRight: number): number {
  return (L + c * (tLeft - tRight)) / 2;
}

export function localizeByArrivals(
  net: CompiledNetwork,
  D: Float64Array,
  locs: Map<string, SensorLoc>,
  onsetsIn: Onset[],
  stepM: number,
  timeS: number,
  relativeSpeedUncertainty = 0.015
): WaveLocalization {
  let onsets = onsetsIn.slice().sort((a, b) => a.tS - b.tS);
  const res: WaveLocalization = { timeS, onsets, candidates: [], ambiguous: false, note: '' };
  if (onsets.length < 2) {
    res.note = 'Недостаточно датчиков с различимым фронтом волны (нужно >= 2).';
    return res;
  }
  const dropped: string[] = [];
  for (let pass = 0; pass < 8; pass++) {
    const out = gridSearch(net, D, locs, onsets, stepM, relativeSpeedUncertainty);
    if (!out) {
      res.note = 'Нет физически связанного пути от кандидатов до датчиков.';
      return res;
    }
    // robust step: drop the worst-fitting onset (late first arrivals behind junctions, reflections)
    const worst = out.normRes.reduce((bi, r, i, a) => (Math.abs(r) > Math.abs(a[bi]!) ? i : bi), 0);
    if (onsets.length > 3 && Math.abs(out.normRes[worst]!) > 4) {
      dropped.push(onsets[worst]!.sensorId);
      onsets = onsets.filter((_, i) => i !== worst);
      continue;
    }
    res.onsets = onsets;
    res.candidates = out.cands.slice(0, 4);
    res.best = out.best;
    res.ambiguous = out.cands.length > 1;
    const dropTxt = dropped.length ? ` Исключены несогласованные приходы: ${dropped.join(', ')}.` : '';
    res.note =
      (res.ambiguous
        ? `Несколько рёбер согласуются с временами прихода (${out.cands.map((c) => c.edgeId).join(', ')}).`
        : `Времена прихода согласуются с одним ребром ${out.best.edgeId}.`) + dropTxt;
    return res;
  }
  return res;
}

function gridSearch(
  net: CompiledNetwork,
  D: Float64Array,
  locs: Map<string, SensorLoc>,
  onsets: Onset[],
  stepM: number,
  relU: number
): { cands: CandidateEdge[]; best: { edgeId: string; distanceM: number; misfit: number; t0S: number }; normRes: number[] } | null {
  const perEdge = new Map<string, { best: number; bestX: number; xs: number[]; Js: number[] }>();
  let global = { J: Number.POSITIVE_INFINITY, edge: '', x: 0, t0: 0, pipe: -1 };
  for (const pp of net.pipes) {
    const nStep = Math.max(2, Math.ceil(pp.L / stepM));
    const rec = { best: Number.POSITIVE_INFINITY, bestX: 0, xs: [] as number[], Js: [] as number[] };
    for (let k = 1; k < nStep; k++) {
      const x = (k * pp.L) / nStep;
      const r = misfitAt(net, D, locs, onsets, pp.index, x, relU);
      if (!r) continue;
      rec.xs.push(x);
      rec.Js.push(r.J);
      if (r.J < rec.best) {
        rec.best = r.J;
        rec.bestX = x;
      }
      if (r.J < global.J) global = { J: r.J, edge: pp.id, x, t0: r.t0, pipe: pp.index };
    }
    if (rec.xs.length) perEdge.set(pp.id, rec);
  }
  if (!Number.isFinite(global.J)) return null;
  const delta = Math.max(4, 0.5 * onsets.length);
  const cands: CandidateEdge[] = [];
  let supSum = 0;
  for (const [edgeId, rec] of perEdge) {
    if (rec.best > global.J + delta) continue;
    const adm = rec.xs.filter((_, i) => rec.Js[i]! <= global.J + delta);
    const sup = Math.exp(-0.5 * (rec.best - global.J));
    supSum += sup;
    cands.push({ edgeId, misfit: rec.best, support: sup, estimatedDistanceM: rec.bestX, intervalM: [Math.min(...adm), Math.max(...adm)], method: 'wave_arrival' });
  }
  cands.sort((a, b) => a.misfit - b.misfit);
  for (const c of cands) c.support = c.support / supSum;
  const fin = misfitAt(net, D, locs, onsets, global.pipe, global.x, relU)!;
  return { cands, best: { edgeId: global.edge, distanceM: global.x, misfit: global.J, t0S: global.t0 }, normRes: fin.normRes };
}

function misfitAt(
  net: CompiledNetwork,
  D: Float64Array,
  locs: Map<string, SensorLoc>,
  onsets: Onset[],
  pipe: number,
  x: number,
  relU: number
): { J: number; t0: number; normRes: number[] } | null {
  let sw = 0;
  let swr = 0;
  const tt: number[] = [];
  const sig: number[] = [];
  for (const o of onsets) {
    const loc = locs.get(o.sensorId);
    const tau = loc ? travelTime(net, D, pipe, x, loc) : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(tau)) return null;
    tt.push(tau);
    // timing uncertainty: sampling/instrument + relative uncertainty of the wave speed along the path
    const s = Math.sqrt(o.sigmaS * o.sigmaS + (relU * tau) * (relU * tau));
    sig.push(s);
    const w = 1 / (s * s);
    sw += w;
    swr += w * (o.tS - tau);
  }
  const t0 = swr / sw;
  let J = 0;
  const normRes: number[] = [];
  onsets.forEach((o, i) => {
    const r = (o.tS - tt[i]! - t0) / sig[i]!;
    normRes.push(r);
    J += r * r;
  });
  return { J, t0, normRes };
}

/**
 * Causal onset of a sharp NEGATIVE residual step in a high-rate series: detection when the drop below
 * a preceding baseline exceeds detectSigma*sigma for `consecutive` samples; onset = first sample where the
 * drop exceeds amplitudeFraction of the step amplitude measured just after detection.
 */
export function detectNegativeOnset(
  t: number[],
  r: number[],
  sigma: number,
  baselineS: number,
  detectSigma: number,
  consecutive: number,
  amplitudeFraction: number,
  searchFromS: number
): { tS: number; amplitude: number } | null {
  const n = t.length;
  if (n < consecutive + 5) return null;
  let j0 = 0;
  for (let k = 0; k < n; k++) {
    if (t[k]! < searchFromS) j0 = k + 1;
  }
  for (let j = Math.max(j0, 1); j < n - consecutive; j++) {
    // baseline from the window just before j
    let s = 0;
    let c = 0;
    for (let k = j - 1; k >= 0 && t[k]! >= t[j]! - baselineS; k--) {
      s += r[k]!;
      c++;
    }
    if (c < 3) continue;
    const base = s / c;
    let ok = true;
    for (let q = 0; q < consecutive; q++) if (base - r[j + q]! < detectSigma * sigma) ok = false;
    if (!ok) continue;
    // amplitude from samples after detection (up to 0.3 s)
    let as = 0;
    let ac = 0;
    for (let k = j; k < n && t[k]! <= t[j]! + 0.3; k++) {
      as += base - r[k]!;
      ac++;
    }
    const amp = as / ac;
    let on = j;
    for (let k = j; k >= 1 && t[k]! >= t[j]! - 0.5; k--) {
      if (base - r[k]! >= amplitudeFraction * amp) on = k;
      else break;
    }
    // linear interpolation of the crossing between on-1 and on
    const thr = amplitudeFraction * amp;
    const d1 = base - r[on]!;
    const d0 = base - r[on - 1]!;
    const w = d1 !== d0 ? (thr - d0) / (d1 - d0) : 1;
    const tOn = t[on - 1]! + Math.min(1, Math.max(0, w)) * (t[on]! - t[on - 1]!);
    return { tS: tOn, amplitude: amp };
  }
  return null;
}
