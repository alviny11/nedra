/**
 * Event-level evaluation of detectors against ground truth. This module has truth access by design
 * (evaluator role); it is never imported by diagnostics-core.
 *
 * Matching protocol (fixed before looking at results):
 *  - a leak event is DETECTED by the first leak alarm (episode with alarmS, cause 'leak') whose alarm
 *    time lies in [start, start + openingDuration + responseWindowS]; latency = alarmS - start;
 *  - one leak = one event; repeated alarms inside an active leak are not extra true positives;
 *  - leak alarms after warm-up that match no leak and occur outside active leaks are FALSE ALARMS;
 *    unmatched alarms while a leak is active are counted as late (the event remains missed);
 *  - normal exposure = time between the end of warm-up and the first leak start (or run end);
 *  - localisation errors are reported only for detected events; wrong edge is counted, not dropped;
 *    a zone-level answer (method mass_balance_zone) is not an edge prediction and counts as wrong edge;
 *  - a leak whose response window is not fully covered by the run (late start, or the run ended by a
 *    model-domain stop) is CENSORED for every detector alike: it is excluded from recall, latency and
 *    localisation, reported separately (with how many detectors caught it anyway), and an alarm matched
 *    to it is never a false or late alarm;
 *  - empty denominators give null, never 0 % / 100 %.
 */
import type { GroundTruthRecord } from '@pipetwin/contracts/truth';

export interface EvalEpisode {
  detector: string;
  episodeId: string;
  startS: number;
  alarmS?: number;
  endS?: number;
  cause: string;
  maxStatus: string;
  candidateEdges: Array<{ edgeId: string; estimatedDistanceM?: number; intervalM?: [number, number]; method: string }>;
  estimatedLeakMassFlowKgs?: number;
}

export interface EvalRun {
  runId: string;
  scenarioId: string;
  truth: GroundTruthRecord;
  episodes: EvalEpisode[];
  commands: Array<{ t: number; kind: string }>;
  warmupS: number;
  durationS: number;
  split?: string;
  tags?: string[];
}

export interface MatchProtocol {
  responseWindowS: number;
  causeWindowS: number;
  bootstrap: number;
  seed: number;
}

export const DEFAULT_PROTOCOL: MatchProtocol = { responseWindowS: 180, causeWindowS: 240, bootstrap: 500, seed: 7 };

export type TruthClass = 'leak' | 'sensor_fault' | 'operating_change' | 'property_change' | 'normal';
export const PRED_CLASSES = ['leak', 'sensor_fault', 'operating_change', 'composition_change', 'unknown', 'normal'] as const;

export interface DetectorMetrics {
  detector: string;
  runs: number;
  leakEvents: number;
  detected: number;
  missed: number;
  /** leaks whose response window lies beyond the end of the run (same for all detectors; not in recall) */
  censoredLeakEvents: number;
  /** of those, how many this detector still alarmed on inside the run (information only) */
  censoredDetected: number;
  recall: number | null;
  recallCI95: [number, number] | null;
  leakAlarms: number;
  truePositiveAlarms: number;
  precision: number | null;
  falseAlarms: number;
  lateAlarms: number;
  normalExposureH: number;
  falseAlarmsPerHour: number | null;
  falseAlarmsPerHourCI95: [number, number] | null;
  latencyMedianS: number | null;
  latencyP95S: number | null;
  localized: number;
  edgeAccuracy: number | null;
  /** share of detected leaks whose true edge is anywhere in the reported candidate set */
  candidateSetCoverage: number | null;
  /** share of detected leaks localised only to a balance zone */
  zoneLevelShare: number | null;
  distanceErrorMedianM: number | null;
  distanceErrorP95M: number | null;
  ambiguousShare: number | null;
  causeConfusion: Record<TruthClass, Record<string, number>>;
  causeMacroF1: number | null;
  perEvent: Array<{ runId: string; scenarioId: string; eventId: string; edgeId: string; detected: boolean; censored?: boolean; latencyS?: number; predictedEdge?: string; inCandidateSet?: boolean; zoneLevel?: boolean; distanceErrorM?: number }>;
}

export interface EvaluationReport {
  protocol: MatchProtocol;
  generatedAt: string;
  datasetSize: { runs: number; totalSimulatedH: number; normalExposureH: number; leakEvents: number; censoredLeakEvents: number };
  detectors: DetectorMetrics[];
  notes: string[];
}

function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RunEval {
  leakEvents: number;
  detected: number;
  falseAlarms: number;
  normalH: number;
}

function evalRun(run: EvalRun, detector: string, P: MatchProtocol, out: DetectorMetrics): RunEval {
  const eps = run.episodes.filter((e) => e.detector === detector);
  const alarms = eps.filter((e) => e.alarmS !== undefined && e.cause === 'leak').sort((a, b) => a.alarmS! - b.alarmS!);
  const leaks = run.truth.events.filter((e) => e.kind === 'leak');
  const used = new Set<string>();
  let detected = 0;
  let censored = 0;
  for (const lk of leaks) {
    const t0 = lk.startTimeS;
    const t1 = t0 + (lk.openingDurationS ?? 0) + P.responseWindowS;
    const hit = alarms.find((a) => !used.has(a.episodeId) && a.alarmS! >= t0 && a.alarmS! <= t1);
    const rec: DetectorMetrics['perEvent'][number] = { runId: run.runId, scenarioId: run.scenarioId, eventId: lk.eventId, edgeId: lk.edgeId!, detected: !!hit };
    if (hit) used.add(hit.episodeId);
    if (run.durationS < t1) {
      rec.censored = true;
      censored++;
      if (hit) {
        rec.latencyS = hit.alarmS! - t0;
        out.censoredDetected++;
      }
      out.perEvent.push(rec);
      continue;
    }
    if (hit) {
      detected++;
      rec.latencyS = hit.alarmS! - t0;
      const top = hit.candidateEdges[0];
      rec.inCandidateSet = hit.candidateEdges.some((c) => c.edgeId === lk.edgeId);
      if (top) {
        rec.zoneLevel = top.method === 'mass_balance_zone';
        if (!rec.zoneLevel) rec.predictedEdge = top.edgeId;
        if (top.edgeId === lk.edgeId && top.estimatedDistanceM !== undefined && top.method !== 'nearest_sensor' && !rec.zoneLevel) {
          rec.distanceErrorM = Math.abs(top.estimatedDistanceM - (lk.appliedDistanceM ?? lk.requestedDistanceM ?? 0));
        }
      }
    }
    out.perEvent.push(rec);
  }
  out.censoredLeakEvents += censored;
  const leakStart = leaks.length ? Math.min(...leaks.map((l) => l.startTimeS)) : Number.POSITIVE_INFINITY;
  let fa = 0;
  let late = 0;
  for (const a of alarms) {
    if (used.has(a.episodeId) || a.alarmS! < run.warmupS) continue;
    if (a.alarmS! >= leakStart) late++;
    else fa++;
  }
  out.lateAlarms += late;
  out.leakAlarms += alarms.filter((a) => a.alarmS! >= run.warmupS).length;
  out.truePositiveAlarms += used.size;
  const normalH = Math.max(0, Math.min(leakStart, run.durationS) - run.warmupS) / 3600;
  return { leakEvents: leaks.length - censored, detected, falseAlarms: fa, normalH };
}

function truthEvents(run: EvalRun): Array<{ cls: TruthClass; t: number }> {
  const ev: Array<{ cls: TruthClass; t: number }> = [];
  for (const e of run.truth.events) {
    if (e.kind === 'leak') ev.push({ cls: 'leak', t: e.startTimeS });
    else if (e.kind === 'sensor_fault') ev.push({ cls: 'sensor_fault', t: e.startTimeS });
    else ev.push({ cls: 'property_change', t: e.startTimeS });
  }
  for (const c of run.commands) if (c.t >= run.warmupS) ev.push({ cls: 'operating_change', t: c.t });
  if (!ev.length) ev.push({ cls: 'normal', t: run.warmupS });
  return ev.sort((a, b) => a.t - b.t);
}

function predictedCause(run: EvalRun, detector: string, t: number, tNext: number, P: MatchProtocol): string {
  const eps = run.episodes
    .filter((e) => e.detector === detector && (e.maxStatus === 'confirmed' || e.maxStatus === 'ambiguous'))
    .filter((e) => (e.alarmS ?? e.startS) >= t - 5 && (e.alarmS ?? e.startS) <= Math.min(t + P.causeWindowS, tNext));
  return eps.length ? eps[0]!.cause : 'normal';
}

const ACCEPT: Record<TruthClass, string[]> = {
  leak: ['leak'],
  sensor_fault: ['sensor_fault'],
  operating_change: ['operating_change', 'normal'],
  property_change: ['normal', 'composition_change'],
  normal: ['normal']
};

function collapse(x: string): 'leak' | 'sensor_fault' | 'other' {
  return x === 'leak' ? 'leak' : x === 'sensor_fault' ? 'sensor_fault' : 'other';
}

export function evaluate(runs: EvalRun[], detectors: string[], P: MatchProtocol = DEFAULT_PROTOCOL): EvaluationReport {
  const notes: string[] = [
    'Все результаты получены на синтетических сценариях одного условного объекта; не являются оценкой промышленной надёжности.',
    'Доверительные интервалы — перцентильный бутстрап по независимым прогонам (runs), не по соседним окнам.'
  ];
  const totalH = runs.reduce((s, r) => s + r.durationS, 0) / 3600;
  const metrics: DetectorMetrics[] = [];
  for (const det of detectors) {
    const m: DetectorMetrics = {
      detector: det,
      runs: runs.length,
      leakEvents: 0,
      detected: 0,
      missed: 0,
      censoredLeakEvents: 0,
      censoredDetected: 0,
      recall: null,
      recallCI95: null,
      leakAlarms: 0,
      truePositiveAlarms: 0,
      precision: null,
      falseAlarms: 0,
      lateAlarms: 0,
      normalExposureH: 0,
      falseAlarmsPerHour: null,
      falseAlarmsPerHourCI95: null,
      latencyMedianS: null,
      latencyP95S: null,
      localized: 0,
      edgeAccuracy: null,
      candidateSetCoverage: null,
      zoneLevelShare: null,
      distanceErrorMedianM: null,
      distanceErrorP95M: null,
      ambiguousShare: null,
      causeConfusion: { leak: {}, sensor_fault: {}, operating_change: {}, property_change: {}, normal: {} },
      causeMacroF1: null,
      perEvent: []
    };
    const per: RunEval[] = runs.map((r) => evalRun(r, det, P, m));
    m.leakEvents = per.reduce((s, r) => s + r.leakEvents, 0);
    m.detected = per.reduce((s, r) => s + r.detected, 0);
    m.missed = m.leakEvents - m.detected;
    m.falseAlarms = per.reduce((s, r) => s + r.falseAlarms, 0);
    m.normalExposureH = per.reduce((s, r) => s + r.normalH, 0);
    m.recall = m.leakEvents ? m.detected / m.leakEvents : null;
    m.precision = m.leakAlarms ? m.truePositiveAlarms / m.leakAlarms : null;
    m.falseAlarmsPerHour = m.normalExposureH > 0 ? m.falseAlarms / m.normalExposureH : null;
    const lat = m.perEvent.filter((e) => e.latencyS !== undefined && !e.censored).map((e) => e.latencyS!);
    m.latencyMedianS = quantile(lat, 0.5);
    m.latencyP95S = quantile(lat, 0.95);
    const det_ = m.perEvent.filter((e) => e.detected && !e.censored);
    const withEdge = det_.filter((e) => e.predictedEdge !== undefined);
    m.localized = withEdge.length;
    m.edgeAccuracy = det_.length ? withEdge.filter((e) => e.predictedEdge === e.edgeId).length / det_.length : null;
    m.candidateSetCoverage = det_.length ? det_.filter((e) => e.inCandidateSet).length / det_.length : null;
    m.zoneLevelShare = det_.length ? det_.filter((e) => e.zoneLevel).length / det_.length : null;
    const dErr = det_.filter((e) => e.distanceErrorM !== undefined).map((e) => e.distanceErrorM!);
    m.distanceErrorMedianM = quantile(dErr, 0.5);
    m.distanceErrorP95M = quantile(dErr, 0.95);
    // bootstrap over runs
    if (runs.length > 1 && P.bootstrap > 0) {
      const rnd = mulberry(P.seed);
      const rec: number[] = [];
      const far: number[] = [];
      for (let b = 0; b < P.bootstrap; b++) {
        let le = 0;
        let de = 0;
        let fa = 0;
        let nh = 0;
        for (let k = 0; k < runs.length; k++) {
          const r = per[Math.floor(rnd() * runs.length)]!;
          le += r.leakEvents;
          de += r.detected;
          fa += r.falseAlarms;
          nh += r.normalH;
        }
        if (le) rec.push(de / le);
        if (nh > 0) far.push(fa / nh);
      }
      if (rec.length && m.leakEvents) m.recallCI95 = [quantile(rec, 0.025)!, quantile(rec, 0.975)!];
      if (far.length && m.normalExposureH > 0) m.falseAlarmsPerHourCI95 = [quantile(far, 0.025)!, quantile(far, 0.975)!];
    }
    // cause confusion
    let amb = 0;
    let epsTotal = 0;
    const pairs: Array<[string, string]> = [];
    let accepted = 0;
    let totalEv = 0;
    for (const r of runs) {
      const evs = truthEvents(r);
      evs.forEach((e, i) => {
        const tNext = i + 1 < evs.length ? evs[i + 1]!.t : Number.POSITIVE_INFINITY;
        const pred = predictedCause(r, det, e.t, tNext, P);
        const row = m.causeConfusion[e.cls];
        row[pred] = (row[pred] ?? 0) + 1;
        pairs.push([collapse(e.cls), collapse(pred)]);
        totalEv++;
        if (ACCEPT[e.cls].includes(pred)) accepted++;
      });
      for (const ep of r.episodes.filter((x) => x.detector === det)) {
        epsTotal++;
        if (ep.maxStatus === 'ambiguous') amb++;
      }
    }
    m.ambiguousShare = epsTotal ? amb / epsTotal : null;
    const classes = ['leak', 'sensor_fault', 'other'] as const;
    const f1s: number[] = [];
    for (const c of classes) {
      const tp = pairs.filter(([t, p]) => t === c && p === c).length;
      const fp = pairs.filter(([t, p]) => t !== c && p === c).length;
      const fn = pairs.filter(([t, p]) => t === c && p !== c).length;
      if (tp + fn === 0) continue;
      const prec = tp + fp ? tp / (tp + fp) : 0;
      const rc = tp / (tp + fn);
      f1s.push(prec + rc ? (2 * prec * rc) / (prec + rc) : 0);
    }
    m.causeMacroF1 = f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : null;
    if (totalEv) notes.push(`${det}: доля событий с приемлемой реакцией по причинам ${(accepted / totalEv).toFixed(2)} (политика: штатная команда и изменение свойств допускают ответ «норма»).`);
    metrics.push(m);
  }
  return {
    protocol: P,
    generatedAt: new Date().toISOString(),
    datasetSize: {
      runs: runs.length,
      totalSimulatedH: totalH,
      normalExposureH: metrics[0]?.normalExposureH ?? 0,
      leakEvents: metrics[0]?.leakEvents ?? 0,
      censoredLeakEvents: metrics[0]?.censoredLeakEvents ?? 0
    },
    detectors: metrics,
    notes
  };
}
