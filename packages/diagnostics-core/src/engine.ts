import type {
  CandidateEdge,
  DetectorId,
  Diagnosis,
  DiagnosisCause,
  DiagnosisStatus,
  EvidenceItem,
  LogisticModelArtifact,
  MeasurementSample,
  PublicCommand,
  PublicScenarioConfig,
  SensorConfig
} from '@pipetwin/contracts';
import { SCHEMA_VERSION } from '@pipetwin/contracts';
import type { CompiledNetwork } from '@pipetwin/physics-core';
import { DETECTOR_VERSION, type DetectorConfig, type MassBalanceGroup } from './config';
import { PhysicsObserver } from './observer';
import { ResidualChannel, median, robustSigma } from './residuals';
import { detectNegativeOnset, localizeByArrivals, nodeTravelTimes, sensorLocations, travelTime, type Onset, type WaveLocalization } from './localization';
import { steadySensitivityFit, type SteadyFitResult } from './steadyFit';
import { FEATURE_NAMES, LogisticClassifier, type FeatureVector } from './features';

type InternalState = 'normal' | 'suspected' | 'confirmed' | 'ambiguous' | 'recovering';

export interface AlarmEpisode {
  episodeId: string;
  detector: DetectorId;
  startS: number;
  alarmS?: number;
  endS?: number;
  cause: DiagnosisCause;
  maxStatus: DiagnosisStatus;
  candidateEdges: CandidateEdge[];
  estimatedLeakMassFlowKgs?: number;
}

interface MbState {
  group: MassBalanceGroup;
  series: Map<string, { t: number[]; v: number[]; rate: number }>;
  invT: number[];
  invM: number[];
  calVals: number[];
  offset: number;
  sigma: number;
  value: number;
  z: number;
  available: boolean;
}

interface DetState {
  id: DetectorId;
  state: InternalState;
  cause: DiagnosisCause;
  episode: AlarmEpisode | null;
  suspectT: number;
  overSince: number | null;
  quietSince: number | null;
  leakSince: number | null;
  isoSince: number | null;
  isoSensor: string | null;
  confirmT: number;
  affected: string[];
  evidence: EvidenceItem[];
  limitations: string[];
  score: number;
  causeScores?: Diagnosis['causeScores'];
  /** D1 only: a leak-consistent abrupt step of one meter with no pressure front yet (positive evidence for a meter fault) */
  meterStepSuspect?: boolean;
  /** D1 only: the physical leak evidence is the balance plus ONE meter (no pressure CUSUM, no front) */
  singleMeter?: string | null;
}

export interface UiSeries {
  t: number[];
  y: number[];
  yhat: number[];
  yhatFixed: number[];
}

const PRESSURE: ReadonlySet<string> = new Set(['pressure']);

export class DiagnosticsEngine {
  readonly cfg: PublicScenarioConfig;
  readonly det: DetectorConfig;
  readonly fixed: PhysicsObserver;
  readonly adaptive: PhysicsObserver;
  private readonly sensors = new Map<string, SensorConfig>();
  readonly resFixed = new Map<string, ResidualChannel>();
  readonly resAdapt = new Map<string, ResidualChannel>();
  private readonly binSeen = new Map<ResidualChannel, number>();
  private readonly pending = new Map<string, MeasurementSample[]>();
  private lastSampleTime = Number.NEGATIVE_INFINITY;
  private tInit = Number.NaN;
  private nextTick = Number.NaN;
  private nextFeature = Number.NaN;
  calibrated = false;
  private readonly mb: MbState[] = [];
  private readonly commandLog: Array<{ t: number; cmd: PublicCommand }> = [];
  private readonly inletHist = new Map<string, { t: number[]; v: number[] }>();
  private onsets: Onset[] = [];
  private lastOnsetBySensor = new Map<string, number>();
  lastWave: WaveLocalization | null = null;
  private waveClusterStart: number | null = null;
  lastFit: SteadyFitResult | null = null;
  private nextFitT = Number.POSITIVE_INFINITY;
  private travelD: Float64Array | null = null;
  private maxTravelS = 15;
  private locs = new Map<string, ReturnType<typeof sensorLocations>[number]>();
  private readonly excluded = new Set<string>();
  readonly classifier: LogisticClassifier | null;
  private lastProba: Record<string, number> | null = null;
  readonly featureRows: Array<{ simTimeS: number; features: FeatureVector }> = [];
  readonly episodes: AlarmEpisode[] = [];
  readonly uiSeries = new Map<string, UiSeries>();
  private readonly d: Record<DetectorId, DetState>;
  private episodeCounter = 0;
  simTimeS = 0;
  status: 'waiting' | 'initialising' | 'calibrating' | 'running' | 'degraded' | 'error' = 'waiting';
  statusMessage = '';

  constructor(cfg: PublicScenarioConfig, det: DetectorConfig, model?: LogisticModelArtifact | null) {
    this.cfg = cfg;
    this.det = det;
    for (const s of cfg.sensors) if (s.availability === 'online') this.sensors.set(s.id, s);
    this.fixed = new PhysicsObserver(cfg, 'fixed', det);
    this.adaptive = new PhysicsObserver(cfg, 'measured', det);
    for (const s of this.sensors.values()) {
      if (s.role !== 'residual') continue;
      const floor = det.sigmaFloor[s.kind];
      this.resFixed.set(s.id, new ResidualChannel(s.id, s.kind, floor, det.binS, 6, s.sampleRateHz));
      this.resAdapt.set(s.id, new ResidualChannel(s.id, s.kind, floor, det.binS, 6, s.sampleRateHz));
      this.pending.set(s.id, []);
      this.uiSeries.set(s.id, { t: [], y: [], yhat: [], yhatFixed: [] });
    }
    for (const g of det.massBalanceGroups) {
      const series = new Map<string, { t: number[]; v: number[]; rate: number }>();
      for (const id of [...g.inflowSensorIds, ...g.outflowSensorIds]) series.set(id, { t: [], v: [], rate: this.sensors.get(id)?.sampleRateHz ?? 1 });
      this.mb.push({ group: g, series, invT: [], invM: [], calVals: [], offset: 0, sigma: 1, value: Number.NaN, z: 0, available: false });
    }
    for (const s of this.sensors.values()) {
      if (s.role === 'boundary_input' && (s.kind === 'temperature' || s.kind === 'waterFraction')) this.inletHist.set(s.id, { t: [], v: [] });
    }
    this.classifier = model ? new LogisticClassifier(model) : null;
    const mk = (id: DetectorId): DetState => ({
      id,
      state: 'normal',
      cause: 'unknown',
      episode: null,
      suspectT: 0,
      overSince: null,
      quietSince: null,
      leakSince: null,
      isoSince: null,
      isoSensor: null,
      confirmT: 0,
      affected: [],
      evidence: [],
      limitations: [],
      score: 0
    });
    this.d = { D0: mk('D0'), D1: mk('D1'), D2: mk('D2') };
    for (const c of cfg.commands) this.commandLog.push({ t: c.simTimeS, cmd: c });
  }

  applyPublicControl(cmd: PublicCommand): void {
    this.fixed.addCommand(cmd);
    this.adaptive.addCommand(cmd);
    this.commandLog.push({ t: cmd.simTimeS, cmd });
    this.commandLog.sort((a, b) => a.t - b.t);
    if (cmd.kind === 'valve_opening') this.travelD = null; // connectivity for waves may change
  }

  ingest(samples: MeasurementSample[]): void {
    for (const s of samples) {
      const sc = this.sensors.get(s.sensorId);
      if (!sc) continue;
      this.lastSampleTime = Math.max(this.lastSampleTime, s.simTimeS);
      this.fixed.ingest(s);
      this.adaptive.ingest(s);
      const q = this.pending.get(s.sensorId);
      if (q) q.push(s);
      if (s.valueSI !== null && s.quality !== 'missing' && s.quality !== 'invalid') {
        for (const m of this.mb) {
          const ser = m.series.get(s.sensorId);
          if (ser) {
            ser.t.push(s.simTimeS);
            ser.v.push(s.valueSI - sc.biasSI);
            if (ser.t.length > 4000) {
              ser.t.splice(0, 1000);
              ser.v.splice(0, 1000);
            }
          }
        }
        const ih = this.inletHist.get(s.sensorId);
        if (ih) {
          ih.t.push(s.simTimeS);
          ih.v.push(s.valueSI);
          if (ih.t.length > 2000) {
            ih.t.splice(0, 500);
            ih.v.splice(0, 500);
          }
        }
      }
    }
  }

  /** advance observers causally, compute residuals and detector decisions; returns true if anything advanced */
  process(): boolean {
    if (!this.fixed.initialized) {
      if (this.lastSampleTime < this.det.initWindowS) return false;
      this.status = 'initialising';
      this.tInit = this.det.initWindowS;
      try {
        this.fixed.initialize(this.tInit);
        this.adaptive.initialize(this.tInit);
      } catch (e) {
        this.status = 'error';
        this.statusMessage = `Наблюдатель не инициализирован: ${(e as Error).message}`;
        return false;
      }
      this.nextTick = Math.floor(this.tInit / this.det.binS + 1) * this.det.binS;
      this.nextFeature = this.det.warmupS;
      this.status = 'calibrating';
    }
    if (this.fixed.error || this.adaptive.error) {
      this.status = 'error';
      this.statusMessage = (this.fixed.error ?? this.adaptive.error)!.message;
      return false;
    }
    let tAvail = Math.min(this.fixed.availableTime(), this.adaptive.availableTime(), this.lastSampleTime);
    if (!Number.isFinite(tAvail) || this.lastSampleTime - tAvail > this.det.maxBoundaryAgeS) {
      tAvail = this.lastSampleTime - this.det.maxBoundaryAgeS;
      this.status = 'degraded';
      this.statusMessage = 'Граничные датчики наблюдателя не обновляются: используется удержание последних значений.';
    }
    const start = this.adaptive.time;
    if (tAvail <= start + 1e-9) return false;
    let t = start;
    while (t < tAvail - 1e-9) {
      const te = Math.min(tAvail, t + 1);
      this.fixed.advanceTo(te);
      this.adaptive.advanceTo(te);
      const tObs = Math.min(this.fixed.time, this.adaptive.time);
      this.consumePending(tObs);
      while (this.nextTick <= tObs + 1e-9) {
        this.tick(this.nextTick);
        this.nextTick += this.det.binS;
      }
      if (this.fixed.error || this.adaptive.error) break;
      t = te;
    }
    this.simTimeS = this.adaptive.time;
    return true;
  }

  private consumePending(tObs: number): void {
    const calibrating = (ts: number): boolean => ts >= this.tInit + this.det.settleS && ts < this.det.warmupS;
    for (const [sid, q] of this.pending) {
      let k = 0;
      const sc = this.sensors.get(sid)!;
      const chF = this.resFixed.get(sid)!;
      const chA = this.resAdapt.get(sid)!;
      const ui = this.uiSeries.get(sid)!;
      while (k < q.length && q[k]!.simTimeS <= tObs - sc.delayS + 1e-9) {
        const s = q[k]!;
        k++;
        if (s.simTimeS < this.tInit) continue;
        const yf = this.fixed.predict(sid, s.simTimeS);
        const ya = this.adaptive.predict(sid, s.simTimeS);
        if (yf === null || ya === null) continue;
        if (s.valueSI === null || s.quality === 'missing' || s.quality === 'invalid') {
          chF.addMissing(s.simTimeS);
          chA.addMissing(s.simTimeS);
          continue;
        }
        const sat = s.quality === 'saturated';
        chF.add(s.simTimeS, s.valueSI - yf, sat, calibrating(s.simTimeS));
        chA.add(s.simTimeS, s.valueSI - ya, sat, calibrating(s.simTimeS));
        const n = ui.t.length;
        if (n === 0 || s.simTimeS - ui.t[n - 1]! >= 0.5) {
          ui.t.push(s.simTimeS);
          ui.y.push(s.valueSI);
          ui.yhat.push(ya);
          ui.yhatFixed.push(yf);
          if (ui.t.length > 2400) {
            ui.t.splice(0, 600);
            ui.y.splice(0, 600);
            ui.yhat.splice(0, 600);
            ui.yhatFixed.splice(0, 600);
          }
        }
      }
      if (k) q.splice(0, k);
    }
  }

  private newBins(ch: ResidualChannel): number[] {
    const seen = this.binSeen.get(ch) ?? 0;
    const out = ch.binMean.slice(Math.min(seen, ch.binMean.length));
    this.binSeen.set(ch, ch.binMean.length);
    // the ring of bins may have been trimmed
    if (ch.binMean.length < seen) this.binSeen.set(ch, ch.binMean.length);
    return out;
  }

  private tick(t: number): void {
    const det = this.det;
    // residual bins -> calibration / statistics
    for (const map of [this.resFixed, this.resAdapt]) {
      for (const ch of map.values()) {
        ch.closeUpTo(t);
        const fresh = this.newBins(ch);
        for (const b of fresh) {
          const bt = ch.binT[ch.binT.length - 1]!;
          if (!this.calibrated) {
            if (bt > this.tInit + det.settleS && bt <= det.warmupS) ch.collectCalibration(b);
          } else if (!this.excluded.has(ch.sensorId)) ch.updateZ(b, det.d1.cusumK);
        }
      }
    }
    // inventory history for mass balance
    for (const m of this.mb) {
      m.invT.push(t);
      m.invM.push(this.adaptive.segmentInventory(m.group.segments));
      if (m.invT.length > 1200) {
        m.invT.splice(0, 300);
        m.invM.splice(0, 300);
      }
      this.updateMassBalance(m, t);
    }
    if (!this.calibrated) {
      if (t >= det.warmupS) {
        for (const map of [this.resFixed, this.resAdapt]) for (const ch of map.values()) ch.finalizeCalibration();
        for (const m of this.mb) {
          const off = median(m.calVals);
          m.offset = Number.isFinite(off) ? off : 0;
          const sg = robustSigma(m.calVals, m.offset);
          // floor from the meter passports (white-noise mean over the window), inflated 1.5x for model error:
          // the calibration window is short and strongly autocorrelated, so its own estimate is not trusted alone
          let v = 0;
          for (const id of [...m.group.inflowSensorIds, ...m.group.outflowSensorIds]) {
            const sc = this.sensors.get(id);
            if (sc) v += (sc.noiseStdSI * sc.noiseStdSI) / (this.det.d1.mbWindowS * sc.sampleRateHz);
          }
          const floor = 1.5 * Math.sqrt(v);
          m.sigma = Math.max(Number.isFinite(sg) ? sg : floor, floor, 0.02);
        }
        this.calibrated = true;
        this.status = 'running';
      }
      return;
    }
    if (this.status === 'calibrating') this.status = 'running';
    this.scanOnsets(t);
    this.stepD0(t);
    this.stepD1(t);
    if (t >= this.nextFeature - 1e-9) {
      const fv = this.computeFeatures(t);
      this.featureRows.push({ simTimeS: t, features: fv });
      if (this.classifier) this.lastProba = this.classifier.predictFromVector(fv);
      this.nextFeature += det.featureStrideS;
    }
    this.stepD2(t);
    const leakState = this.d.D1.state === 'confirmed' && this.d.D1.cause === 'leak' ? this.d.D1 : this.d.D2.state === 'confirmed' && this.d.D2.cause === 'leak' ? this.d.D2 : null;
    if (t >= this.nextFitT && leakState) {
      this.runSteadyFit(t, leakState);
      this.nextFitT = t + 60;
    }
  }

  // ------------------------------------------------------------------ mass balance

  private updateMassBalance(m: MbState, t: number): void {
    const W = this.det.d1.mbWindowS;
    const t0 = t - W;
    if (t0 < this.tInit + this.det.settleS) {
      m.available = false;
      return;
    }
    let inflow = 0;
    let outflow = 0;
    let ok = true;
    // a meter diagnosed as faulty makes this balance unavailable (it cannot be closed without it)
    for (const id of m.series.keys()) if (this.excluded.has(id)) ok = false;
    for (const [id, ser] of m.series) {
      let s = 0;
      let c = 0;
      for (let k = ser.t.length - 1; k >= 0; k--) {
        const ts = ser.t[k]!;
        if (ts <= t0) break;
        if (ts > t) continue;
        s += ser.v[k]!;
        c++;
      }
      if (c < 0.5 * W * ser.rate) ok = false;
      const mean = c ? s / c : 0;
      if (m.group.inflowSensorIds.includes(id)) inflow += mean;
      else outflow += mean;
    }
    // inventory change of the observer over the window
    let Mnow = m.invM[m.invM.length - 1]!;
    let Mold = Number.NaN;
    for (let k = m.invT.length - 1; k >= 0; k--) if (m.invT[k]! <= t0 + 1e-9) {
      Mold = m.invM[k]!;
      break;
    }
    if (!Number.isFinite(Mold)) ok = false;
    m.available = ok;
    if (!ok) return;
    m.value = inflow - outflow - (Mnow - Mold) / W;
    if (!this.calibrated) {
      if (t <= this.det.warmupS) m.calVals.push(m.value);
    } else m.z = (m.value - m.offset) / m.sigma;
    Mnow = 0;
  }

  /** leak mass flow estimate from the integral balance [kg/s] */
  private mbLeak(): { kgs: number; z: number; group?: MassBalanceGroup } {
    let best = { kgs: Number.NaN, z: Number.NEGATIVE_INFINITY } as { kgs: number; z: number; group?: MassBalanceGroup };
    for (const m of this.mb) if (m.available && m.z > best.z) best = { kgs: m.value - m.offset, z: m.z, group: m.group };
    return best;
  }

  /** at least three residual pressure sensors fast enough to time a negative front (>= 20 Hz) */
  private isWaveCapable(): boolean {
    let n = 0;
    for (const ch of this.resAdapt.values()) {
      const sc = this.sensors.get(ch.sensorId);
      if (ch.kind === 'pressure' && !this.excluded.has(ch.sensorId) && sc && sc.sampleRateHz >= 20) n++;
    }
    return n >= 3;
  }

  /** negative pressure fronts at >= 2 sensors within the feature window that no known public command explains */
  private waveEvidence(t: number): boolean {
    const recent = this.onsets.filter((o) => o.tS > t - this.det.featureWindowS);
    if (new Set(recent.map((o) => o.sensorId)).size < 2) return false;
    const t0 = Math.min(...recent.map((o) => o.tS));
    return !this.commandLog.some((e) => e.t <= t0 + 1 && t0 - e.t < this.det.d1.commandGuardS);
  }

  /** inflow meter above / outflow meter below prediction: the direction a leak inside its balance zone produces */
  private flowLeakConsistent(sensorId: string, z: number): boolean {
    for (const m of this.mb) {
      if (z > 0 && m.group.inflowSensorIds.includes(sensorId)) return true;
      if (z < 0 && m.group.outflowSensorIds.includes(sensorId)) return true;
    }
    return false;
  }

  /** largest 5 s-to-5 s change of a channel within the last 60 s, relative to its current deviation (step ~ 1, ramp << 1) */
  private stepShare(ch: ResidualChannel, t: number): number {
    const cur = ch.meanBetween(t - 5, t) - ch.offset;
    if (!Number.isFinite(cur) || Math.abs(cur) < 1e-12) return 0;
    let best = 0;
    for (let k = t - 55; k <= t - 5; k += 1) {
      const a = ch.meanBetween(k, k + 5);
      const b = ch.meanBetween(k - 6, k - 1);
      if (Number.isFinite(a) && Number.isFinite(b)) best = Math.max(best, Math.abs(a - b));
    }
    return best / Math.abs(cur);
  }

  // ------------------------------------------------------------------ waves

  private ensureTravel(): void {
    if (this.travelD || !this.adaptive.net || !this.adaptive.model) return;
    const net = this.adaptive.net;
    const model = this.adaptive.model;
    this.travelD = nodeTravelTimes(net, (d) => model.valveOpening[d]! > 0);
    const locs = sensorLocations(net, [...this.sensors.values()]);
    this.locs = new Map(locs.map((l) => [l.sensorId, l]));
    let mx = 0;
    const nN = net.nodes.length;
    for (let i = 0; i < nN * nN; i++) if (Number.isFinite(this.travelD[i]!)) mx = Math.max(mx, this.travelD[i]!);
    let maxPipe = 0;
    for (const p of net.pipes) maxPipe = Math.max(maxPipe, p.L / p.c);
    this.maxTravelS = mx + maxPipe;
  }

  private scanOnsets(t: number): void {
    const w = this.det.wave;
    this.ensureTravel();
    for (const ch of this.resAdapt.values()) {
      if (ch.kind !== 'pressure' || this.excluded.has(ch.sensorId)) continue;
      const last = this.lastOnsetBySensor.get(ch.sensorId);
      if (last !== undefined && t - last < 60) continue;
      const hr = ch.hrBetween(t - 1.6 - w.baselineS, t);
      const on = detectNegativeOnset(hr.t, hr.r, ch.sigmaHr, w.baselineS, w.detectSigma, w.consecutive, w.amplitudeFraction, t - 1.6);
      if (!on) continue;
      const sc = this.sensors.get(ch.sensorId)!;
      const sig = Math.max(w.minTimingSigmaS, 1 / sc.sampleRateHz, sc.timeConstantS);
      this.onsets.push({ sensorId: ch.sensorId, tS: on.tS, amplitude: on.amplitude, sigmaS: sig });
      this.lastOnsetBySensor.set(ch.sensorId, on.tS);
      if (this.waveClusterStart === null || on.tS - this.waveClusterStart > this.maxTravelS + 1) this.waveClusterStart = on.tS;
    }
    this.onsets = this.onsets.filter((o) => t - o.tS < 120);
    if (this.waveClusterStart !== null && t - this.waveClusterStart >= this.maxTravelS + 1.5) {
      const cl = this.onsets.filter((o) => o.tS >= this.waveClusterStart! - 0.5 && o.tS <= this.waveClusterStart! + this.maxTravelS + 0.5);
      // keep the earliest onset per sensor
      const by = new Map<string, Onset>();
      for (const o of cl) if (!by.has(o.sensorId) || by.get(o.sensorId)!.tS > o.tS) by.set(o.sensorId, o);
      const list = [...by.values()];
      const prev = this.lastWave;
      const prevStrong = prev && t - prev.timeS < 180 && prev.onsets.length > list.length;
      if (list.length >= 2 && this.adaptive.net && this.travelD && !prevStrong) {
        this.lastWave = localizeByArrivals(this.adaptive.net, this.travelD, this.locs, list, this.det.wave.candidateStepM, t);
      } else if (list.length === 1 && !(prev && t - prev.timeS < 180)) {
        this.lastWave = { timeS: t, onsets: list, candidates: [], ambiguous: true, note: `Фронт различим только на ${list[0]!.sensorId}: волновая локализация невозможна.` };
      }
      this.waveClusterStart = null;
    }
  }

  // ------------------------------------------------------------------ detectors

  private pressureChannels(map: Map<string, ResidualChannel>): ResidualChannel[] {
    return [...map.values()].filter((c) => PRESSURE.has(c.kind) && !this.excluded.has(c.sensorId));
  }

  private openEpisode(st: DetState, t: number): void {
    st.episode = { episodeId: `${st.id}-${++this.episodeCounter}`, detector: st.id, startS: t, cause: 'unknown', maxStatus: 'suspected', candidateEdges: [] };
    this.episodes.push(st.episode);
  }

  private closeEpisode(st: DetState, t: number): void {
    if (st.episode) st.episode.endS = t;
    st.episode = null;
  }

  private stepD0(t: number): void {
    const st = this.d.D0;
    const cfg = this.det.d0;
    const chans = this.pressureChannels(this.resFixed);
    const over = chans.filter((c) => Math.abs(c.z) > cfg.zThreshold);
    const maxCh = chans.reduce<ResidualChannel | null>((m, c) => (!m || Math.abs(c.z) > Math.abs(m.z) ? c : m), null);
    st.score = maxCh ? Math.abs(maxCh.z) : 0;
    st.affected = over.map((c) => c.sensorId);
    if (st.state === 'normal' || st.state === 'suspected') {
      if (over.length) {
        if (st.overSince === null) {
          st.overSince = t;
          st.state = 'suspected';
          this.openEpisode(st, t);
        }
        if (t - st.overSince >= cfg.holdS) {
          st.state = 'confirmed';
          st.cause = 'leak';
          st.confirmT = t;
          st.quietSince = null;
          if (st.episode) {
            st.episode.alarmS = t;
            st.episode.cause = 'leak';
            st.episode.maxStatus = 'confirmed';
            st.episode.candidateEdges = maxCh ? this.nearestEdges(maxCh.sensorId) : [];
          }
        }
      } else if (st.state === 'suspected') {
        st.state = 'normal';
        st.overSince = null;
        this.closeEpisode(st, t);
      }
    } else if (st.state === 'confirmed') {
      const quiet = chans.every((c) => Math.abs(c.z) < cfg.zThreshold / 2);
      if (quiet) {
        st.quietSince ??= t;
        if (t - st.quietSince >= cfg.releaseS) {
          st.state = 'normal';
          st.overSince = null;
          this.closeEpisode(st, t);
        }
      } else st.quietSince = null;
    }
    st.evidence = over.length
      ? [{ code: 'D0_THRESHOLD', text: `|невязка| > ${cfg.zThreshold}σ: ${over.map((c) => `${c.sensorId} (${c.z.toFixed(1)}σ)`).join(', ')}`, sensorIds: over.map((c) => c.sensorId) }]
      : [];
    st.limitations = ['D0: наблюдатель с фиксированными свойствами среды (паспорт при опорных T, Y_w); без учёта измеренной температуры и обводнённости.', 'D0 не различает причины: любая устойчивая тревога трактуется как утечка.'];
  }

  private flowPattern(): number {
    let zin = 0;
    let nin = 0;
    let zout = 0;
    let nout = 0;
    for (const m of this.mb) {
      for (const id of m.group.inflowSensorIds) {
        const ch = this.resAdapt.get(id);
        if (ch && !this.excluded.has(id)) {
          zin += ch.meanZ(10);
          nin++;
        }
      }
      for (const id of m.group.outflowSensorIds) {
        const ch = this.resAdapt.get(id);
        if (ch && !this.excluded.has(id)) {
          zout += ch.meanZ(10);
          nout++;
        }
      }
    }
    return (nin ? zin / nin : 0) - (nout ? zout / nout : 0);
  }

  /** robust change of measured inlet properties: |mean(last 10 s) - mean(first 10 s of the window)| */
  private inletChange(t: number): { dT: number; dW: number } {
    let dT = 0;
    let dW = 0;
    const W = this.det.featureWindowS;
    for (const [id, h] of this.inletHist) {
      const sc = this.sensors.get(id)!;
      let sa = 0;
      let ca = 0;
      let sb = 0;
      let cb = 0;
      for (let k = h.t.length - 1; k >= 0 && h.t[k]! > t - W; k--) {
        const ts = h.t[k]!;
        if (ts > t - 10) {
          sa += h.v[k]!;
          ca++;
        } else if (ts <= t - W + 10) {
          sb += h.v[k]!;
          cb++;
        }
      }
      if (!ca || !cb) continue;
      const d = Math.abs(sa / ca - sb / cb);
      if (sc.kind === 'temperature') dT = Math.max(dT, d);
      else dW = Math.max(dW, d);
    }
    return { dT, dW };
  }

  private rebaselinedFor = new Set<number>();

  private stepD1(t: number): void {
    const st = this.d.D1;
    const c = this.det.d1;
    // Known public operating change: once its transient has settled (t_cmd + 120 s), residual offsets of
    // the adaptive observer are re-baselined, unless the integral balance shows a deficit. Never during a
    // confirmed leak. This absorbs the change of model error with the operating point, not unknown events.
    for (const e of this.commandLog) {
      if (e.t < this.det.warmupS || this.rebaselinedFor.has(e.t) || t < e.t + 120 || t > e.t + 180) continue;
      this.rebaselinedFor.add(e.t);
      const mbNow = this.mbLeak();
      if (st.state === 'confirmed' && st.cause === 'leak') continue;
      if (this.mb.some((m) => m.available) && mbNow.z > 0.5 * c.mbZThreshold) continue;
      for (const ch of this.resAdapt.values()) ch.rebaseline(t, 30);
      if (st.state !== 'normal' && st.cause !== 'leak') {
        st.state = 'recovering';
        st.quietSince = t;
      }
    }
    const pch = this.pressureChannels(this.resAdapt);
    const negP = pch.filter((ch) => ch.sNeg > c.cusumH);
    const posP = pch.filter((ch) => ch.sPos > c.cusumH);
    const mbl = this.mbLeak();
    const mbAvail = this.mb.some((m) => m.available);
    const leakMB = mbAvail && mbl.z > c.mbZThreshold;
    const fp = this.flowPattern();
    // flow meters deviating in the leak-consistent direction (inflow above, outflow below prediction)
    let flowLeakLike = 0;
    for (const m of this.mb) {
      for (const id of m.group.inflowSensorIds) if (!this.excluded.has(id) && (this.resAdapt.get(id)?.meanZ(10) ?? 0) > 3) flowLeakLike++;
      for (const id of m.group.outflowSensorIds) if (!this.excluded.has(id) && (this.resAdapt.get(id)?.meanZ(10) ?? 0) < -3) flowLeakLike++;
    }
    // a balance deficit alone can be produced by ONE biased meter; a leak needs pressure evidence, a
    // consistent change of at least two meters, or a negative pressure front seen at >= 2 sensors (a meter
    // fault sends no pressure wave)
    const waveEv = this.waveEvidence(t);
    const leakSig =
      (leakMB && (negP.length >= 1 || flowLeakLike >= 2 || (flowLeakLike >= 1 && waveEv))) ||
      (!mbAvail && negP.length >= c.minPressureSensorsForLeak && fp > 3);
    const devs = [...this.resAdapt.values()]
      .filter((ch) => !this.excluded.has(ch.sensorId) && (ch.kind === 'pressure' || ch.kind === 'massFlow'))
      .map((ch) => ({ id: ch.sensorId, z: ch.meanZ(10) }))
      .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
    const topIsFlow = devs.length > 0 && this.sensors.get(devs[0]!.id)?.kind === 'massFlow';
    // A leak-consistent deviation of ONE meter is also what a leak inside its balance zone looks like when
    // no other sensor sees it (e.g. a leak between the last pressure sensor and a pressure boundary). The
    // meter is blamed only with positive evidence for a meter fault: an abrupt step (full deviation within
    // ~5 s) while the high-rate pressure sensors saw no front. Otherwise the case stays ambiguous and the
    // meter is NOT excluded (excluding it would also switch off the balance that sees the leak).
    const topLeakConsistent = topIsFlow && this.flowLeakConsistent(devs[0]!.id, devs[0]!.z);
    const topCh = devs.length ? this.resAdapt.get(devs[0]!.id) : undefined;
    const meterFaultEvidence = !topLeakConsistent || (this.isWaveCapable() && !waveEv && topCh !== undefined && this.stepShare(topCh, t) >= 0.6);
    const flowOrLeak = topLeakConsistent && Math.abs(devs[0]!.z) > c.sensorFaultZ && !meterFaultEvidence;
    st.meterStepSuspect = topLeakConsistent && this.isWaveCapable() && !waveEv && topCh !== undefined && Math.abs(devs[0]!.z) > 3 && this.stepShare(topCh, t) >= 0.6;
    st.singleMeter = topLeakConsistent && negP.length === 0 && !waveEv && flowLeakLike <= 1 ? devs[0]!.id : null;
    // isolated deviation: one sensor far off, the others normal. For a flow meter the balance itself is
    // driven by that meter, so the criterion is "no pressure evidence" instead of "balance normal".
    const isolated =
      devs.length > 1 &&
      Math.abs(devs[0]!.z) > c.sensorFaultZ &&
      Math.abs(devs[1]!.z) < c.sensorFaultOthersMaxZ &&
      (topIsFlow ? negP.length + posP.length === 0 && !waveEv && meterFaultEvidence : !mbAvail || Math.abs(mbl.z) < 3);
    const lastCmd = this.commandLog.filter((e) => e.t <= t).pop();
    const recentCmd = lastCmd !== undefined && t - lastCmd.t < c.commandGuardS;
    const inl = this.inletChange(t);
    const inletChanged = inl.dT > 2 || inl.dW > 0.02;
    const anyEvidence = negP.length + posP.length > 0 || (mbAvail && Math.abs(mbl.z) > 0.75 * c.mbZThreshold) || isolated;
    st.score = Math.max(mbAvail ? mbl.z : 0, ...pch.map((ch) => Math.max(ch.sNeg, ch.sPos) / c.cusumH), 0);

    const toConfirmedLeak = (): void => {
      if (st.state === 'confirmed' && st.cause === 'leak') return;
      if (st.state === 'confirmed' && st.cause !== 'leak') {
        this.closeEpisode(st, t);
        this.openEpisode(st, t);
        st.suspectT = t;
      }
      if (!st.episode) this.openEpisode(st, t);
      st.state = 'confirmed';
      st.cause = 'leak';
      st.confirmT = t;
      st.quietSince = null;
      st.episode!.alarmS = t;
      st.episode!.cause = 'leak';
      st.episode!.maxStatus = 'confirmed';
      this.nextFitT = t + this.det.steadyFit.afterConfirmS;
    };

    switch (st.state) {
      case 'normal':
      case 'recovering':
        if (leakSig) {
          if (st.state === 'normal') {
            this.openEpisode(st, t);
            st.suspectT = t;
          }
          st.state = 'suspected';
          st.leakSince = t;
        } else if (anyEvidence) {
          if (st.state === 'normal') {
            this.openEpisode(st, t);
            st.suspectT = t;
          }
          st.state = 'suspected';
          st.quietSince = null;
        } else if (st.state === 'recovering') {
          st.quietSince ??= t;
          if (t - st.quietSince >= c.recoverS) {
            st.state = 'normal';
            this.closeEpisode(st, t);
          }
        }
        break;
      case 'suspected':
      case 'ambiguous': {
        if (leakSig) {
          st.leakSince ??= t;
          if (t - st.leakSince >= c.leakConfirmS) toConfirmedLeak();
        } else st.leakSince = null;
        const cur = (): InternalState => st.state;
        if (cur() !== 'confirmed' && isolated) {
          if (st.isoSensor !== devs[0]!.id) {
            st.isoSensor = devs[0]!.id;
            st.isoSince = t;
          }
          if (t - st.isoSince! >= c.sensorFaultConfirmS) {
            st.state = 'confirmed';
            st.cause = 'sensor_fault';
            st.confirmT = t;
            this.excluded.add(st.isoSensor);
            this.resAdapt.get(st.isoSensor)?.resetCusum();
            if (st.episode) {
              st.episode.alarmS = t;
              st.episode.cause = 'sensor_fault';
              st.episode.maxStatus = 'confirmed';
            }
            st.affected = [st.isoSensor];
          }
        } else if (!isolated) {
          st.isoSensor = null;
          st.isoSince = null;
        }
        if (cur() === 'suspected' || cur() === 'ambiguous') {
          if (!anyEvidence) {
            st.quietSince ??= t;
            if (t - st.quietSince >= c.recoverS) {
              st.state = 'normal';
              this.closeEpisode(st, t);
            }
          } else st.quietSince = null;
          if (cur() === 'suspected' && t - st.suspectT >= c.ambiguousAfterS) {
            st.state = 'ambiguous';
            if (st.episode) st.episode.maxStatus = st.episode.maxStatus === 'confirmed' ? 'confirmed' : 'ambiguous';
          }
          st.cause = recentCmd ? 'operating_change' : inletChanged ? 'composition_change' : 'unknown';
          if (st.episode && st.episode.cause !== 'leak' && st.episode.cause !== 'sensor_fault') st.episode.cause = st.cause;
          // re-baseline after a KNOWN public operating change once settled, never with leak evidence
          if (st.cause === 'operating_change' && !leakMB && lastCmd && t - lastCmd.t > 60 && t - lastCmd.t < c.commandGuardS + 60) {
            for (const ch of this.resAdapt.values()) ch.rebaseline(t, 20);
            st.state = 'recovering';
            st.quietSince = t;
          }
        }
        break;
      }
      case 'confirmed':
        if (st.cause === 'leak') {
          const ev = leakMB || negP.length > 0;
          if (!ev) {
            st.quietSince ??= t;
            if (t - st.quietSince >= c.recoverS) {
              st.state = 'recovering';
              st.quietSince = t;
            }
          } else st.quietSince = null;
        } else if (st.cause === 'sensor_fault') {
          if (leakSig) {
            st.leakSince ??= t;
            if (t - st.leakSince >= c.leakConfirmS) toConfirmedLeak();
          } else if (t - st.confirmT > 60) {
            st.state = 'normal';
            this.closeEpisode(st, t);
          }
        }
        break;
    }
    // evidence text from computed facts only
    const ev: EvidenceItem[] = [];
    if (negP.length) ev.push({ code: 'P_BELOW', text: `Давление ниже расчётного (CUSUM): ${negP.map((ch) => ch.sensorId).join(', ')}`, sensorIds: negP.map((ch) => ch.sensorId) });
    if (posP.length) ev.push({ code: 'P_ABOVE', text: `Давление выше расчётного (CUSUM): ${posP.map((ch) => ch.sensorId).join(', ')}`, sensorIds: posP.map((ch) => ch.sensorId) });
    if (mbAvail && Number.isFinite(mbl.kgs)) {
      const g = mbl.group?.name ?? '';
      ev.push({
        code: 'MASS_BALANCE',
        text: leakMB
          ? `Баланс «${g}» не объясняется оценённым накоплением: дефицит ${mbl.kgs.toFixed(2)} кг/с (${mbl.z.toFixed(1)}σ)`
          : `Баланс «${g}» в норме (${mbl.z.toFixed(1)}σ)`,
        value: mbl.kgs
      });
    } else ev.push({ code: 'MASS_BALANCE_UNAVAILABLE', text: 'Интегральный баланс недоступен (пропуски расходомеров или окно ещё не заполнено).' });
    if (Math.abs(fp) > 3) ev.push({ code: 'FLOW_PATTERN', text: `Расходомеры: приток выше/отток ниже расчётного (${fp.toFixed(1)}σ)`, value: fp });
    if (st.cause === 'sensor_fault' && st.affected.length) ev.push({ code: 'ISOLATED_SENSOR', text: `Отклоняется только ${st.affected[0]}; соседние датчики и баланс в норме — вероятна неисправность датчика`, sensorIds: st.affected });
    if (flowOrLeak && st.cause !== 'leak' && st.cause !== 'sensor_fault') {
      ev.push({
        code: 'FLOW_OR_LEAK',
        text: `Отклоняется расходомер ${devs[0]!.id} в сторону, совместимую с утечкой в его зоне баланса; скачка без волны давления нет — неисправность расходомера и утечка не различимы, расходомер не исключается.`,
        sensorIds: [devs[0]!.id]
      });
    }
    if (recentCmd && lastCmd) ev.push({ code: 'PUBLIC_COMMAND', text: `Публичная команда ${describeCommand(lastCmd.cmd)} в t=${lastCmd.t.toFixed(0)} с` });
    if (inletChanged) ev.push({ code: 'INLET_CHANGE', text: `Изменение измеренных свойств на входе: ΔT=${inl.dT.toFixed(1)} K, Δα_w=${inl.dW.toFixed(3)} (учтено наблюдателем D1)` });
    if (this.lastWave && this.lastWave.onsets.length && t - this.lastWave.timeS < 300) {
      ev.push({ code: 'WAVE', text: `Фронты волны: ${this.lastWave.onsets.map((o) => `${o.sensorId} ${o.tS.toFixed(2)} с`).join(', ')}. ${this.lastWave.note}` });
    }
    if (this.lastFit && t - this.lastFit.timeS < 400) ev.push({ code: 'STEADY_FIT', text: this.lastFit.note });
    st.evidence = ev;
    const lim: string[] = [];
    if (this.excluded.size) lim.push(`Исключены как неисправные: ${[...this.excluded].join(', ')}`);
    lim.push('Score и поддержка кандидатов — не откалиброванные вероятности.');
    const lowRate = [...this.sensors.values()].some((s) => s.kind === 'pressure' && s.role === 'residual' && s.sampleRateHz < 10);
    if (lowRate) lim.push('Низкая частота опроса давления: точность волновой локализации порядка c·Δt/2.');
    st.limitations = lim;
    if (st.state !== 'confirmed' || st.cause !== 'sensor_fault') st.affected = [...negP, ...posP].map((ch) => ch.sensorId);
    if (st.episode && st.cause === 'leak') {
      st.episode.candidateEdges = this.leakCandidates(st).candidates;
      st.episode.estimatedLeakMassFlowKgs = Number.isFinite(mbl.kgs) ? mbl.kgs : this.lastFit?.best?.leakKgS;
    }
  }

  private stepD2(t: number): void {
    const st = this.d.D2;
    const d1 = this.d.D1;
    const prevState = st.state;
    const prevCause = st.cause;
    if (!this.classifier || !this.lastProba) {
      st.state = d1.state;
      st.cause = d1.cause;
      st.score = d1.score;
      st.evidence = [...d1.evidence];
      st.limitations = [...d1.limitations, this.classifier ? 'Классификатор ещё не дал оценку (окно признаков не заполнено).' : 'ML unavailable: артефакт модели не загружен — D2 повторяет D1.'];
      st.causeScores = undefined;
    } else {
      const p = this.lastProba;
      const top = Object.entries(p).sort((a, b) => b[1] - a[1])[0]!;
      const minTop = this.classifier.artifact.decisionThresholds.minTopScore;
      const mbl = this.mbLeak();
      const strongPhysics = mbl.z > 2 * this.det.d1.mbZThreshold || this.pressureChannels(this.resAdapt).filter((ch) => ch.sNeg > this.det.d1.cusumH).length >= 3;
      let state: InternalState = d1.state;
      let cause: DiagnosisCause = d1.cause;
      if (d1.state === 'confirmed' && d1.cause === 'leak') {
        if (!strongPhysics && (p.leak ?? 0) < 0.2 && top[0] !== 'leak' && top[1] > minTop) {
          state = 'ambiguous';
          cause = top[0] === 'normal' ? 'unknown' : (top[0] as DiagnosisCause);
        }
      } else if (d1.state === 'suspected' || d1.state === 'ambiguous') {
        // the classifier may resolve a D1 suspicion, but not against positive physical evidence for a meter
        // fault (abrupt step of one meter without a pressure front): D1's isolation decides that case
        if (!d1.meterStepSuspect && (p.leak ?? 0) > 0.8 && (mbl.z > this.det.d1.mbZThreshold / 2 || this.pressureChannels(this.resAdapt).some((ch) => ch.sNeg > this.det.d1.cusumH))) {
          state = 'confirmed';
          cause = 'leak';
        } else if (top[0] !== 'normal' && top[0] !== 'leak' && top[1] > minTop) {
          cause = top[0] as DiagnosisCause;
        }
      }
      st.state = state;
      st.cause = cause;
      st.score = d1.score;
      st.causeScores = p as Diagnosis['causeScores'];
      st.evidence = [...d1.evidence, { code: 'ML', text: `Классификатор: ${Object.entries(p).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}` }];
      if (state === 'confirmed' && cause === 'leak' && !(d1.state === 'confirmed' && d1.cause === 'leak') && d1.singleMeter) {
        st.evidence.push({
          code: 'SINGLE_METER',
          text: `Утечка подтверждена классификатором; физически её видят только баланс и расходомер ${d1.singleMeter} (нет падения давления и фронта волны) — неисправность ${d1.singleMeter} не исключена.`,
          sensorIds: [d1.singleMeter]
        });
      }
      st.limitations = [...d1.limitations, `Модель ${this.classifier.artifact.modelVersion}; ${this.classifier.artifact.calibration.status === 'validated' ? 'калибровка проверена на валидации' : 'вероятности не откалиброваны (выводится score)'}.`];
    }
    // episodes for D2
    const alarm = st.state === 'confirmed' && st.cause === 'leak';
    const wasAlarm = prevState === 'confirmed' && prevCause === 'leak';
    if (st.state !== 'normal' && !st.episode) {
      this.openEpisode(st, t);
      st.suspectT = d1.episode?.startS ?? t;
    }
    if (alarm && !wasAlarm) {
      st.confirmT = t;
      if (!(d1.state === 'confirmed' && d1.cause === 'leak')) this.nextFitT = Math.min(this.nextFitT, t + this.det.steadyFit.afterConfirmS);
    }
    if (st.episode) {
      if (alarm && !wasAlarm) {
        st.episode.alarmS ??= t;
        st.episode.cause = 'leak';
        st.episode.maxStatus = 'confirmed';
      } else if (!alarm && st.state !== 'normal' && st.episode.cause !== 'leak') {
        st.episode.cause = st.cause;
        if (st.state === 'confirmed') {
          st.episode.maxStatus = 'confirmed';
          st.episode.alarmS ??= t;
        }
        else if (st.state === 'ambiguous' && st.episode.maxStatus === 'suspected') st.episode.maxStatus = 'ambiguous';
      }
      if (alarm) {
        st.episode.candidateEdges = this.leakCandidates(st).candidates;
        const mbl = this.mbLeak();
        st.episode.estimatedLeakMassFlowKgs = Number.isFinite(mbl.kgs) && mbl.kgs > 0 ? mbl.kgs : this.lastFit?.best?.leakKgS;
      }
    }
    if (st.state === 'normal' && st.episode) this.closeEpisode(st, t);
    st.affected = d1.affected;
  }

  private nearestEdges(sensorId: string): CandidateEdge[] {
    const s = this.sensors.get(sensorId);
    if (!s) return [];
    if (s.edgeId) return [{ edgeId: s.edgeId, misfit: 0, support: 1, estimatedDistanceM: s.distanceM, method: 'nearest_sensor' }];
    const pipes = this.cfg.links.filter((l) => l.kind === 'pipe' && (l.fromNodeId === s.nodeId || l.toNodeId === s.nodeId));
    return pipes.map((p) => ({ edgeId: p.id, misfit: 0, support: 1 / Math.max(1, pipes.length), method: 'nearest_sensor' as const }));
  }

  private leakCandidates(st: DetState): { candidates: CandidateEdge[]; method: string } {
    const waveFresh = this.lastWave && this.lastWave.candidates.length && this.lastWave.timeS >= st.suspectT - 20;
    const fitFresh = this.lastFit && this.lastFit.candidates.length && this.lastFit.timeS >= st.confirmT;
    if (waveFresh && fitFresh && this.lastWave!.ambiguous) {
      // re-rank ambiguous wave candidates with the steady residual fit
      const fitRank = new Map(this.lastFit!.candidates.map((c, i) => [c.edgeId, i]));
      const cands = [...this.lastWave!.candidates].sort((a, b) => (fitRank.get(a.edgeId) ?? 99) - (fitRank.get(b.edgeId) ?? 99));
      return { candidates: cands, method: 'combined' };
    }
    if (waveFresh) return { candidates: this.lastWave!.candidates, method: 'wave' };
    if (fitFresh) return { candidates: this.lastFit!.candidates, method: 'fit' };
    const strongest = this.pressureChannels(this.resAdapt).sort((a, b) => b.sNeg - a.sNeg)[0];
    if (strongest && strongest.sNeg > this.det.d1.cusumH) return { candidates: this.nearestEdges(strongest.sensorId), method: 'nearest' };
    // no front, no fit yet, no significant pressure drop: the balance zone in deficit is the only location information
    const mbl = this.mbLeak();
    if (mbl.group && Number.isFinite(mbl.z) && mbl.z > 0.75 * this.det.d1.mbZThreshold) {
      const segs = mbl.group.segments;
      return {
        candidates: segs.map((g) => ({ edgeId: g.edgeId, misfit: 0, support: 1 / Math.max(1, segs.length), intervalM: [g.fromM, g.toM] as [number, number], method: 'mass_balance_zone' as const })),
        method: 'mass_balance_zone'
      };
    }
    return { candidates: strongest ? this.nearestEdges(strongest.sensorId) : [], method: 'nearest' };
  }

  private runSteadyFit(t: number, st: DetState): void {
    const net = this.adaptive.net;
    const model = this.adaptive.model;
    if (!net || !model) return;
    const sf = this.det.steadyFit;
    const used: SensorConfig[] = [];
    const dr: number[] = [];
    const w: number[] = [];
    for (const ch of this.resAdapt.values()) {
      if (this.excluded.has(ch.sensorId) || (ch.kind !== 'pressure' && ch.kind !== 'massFlow')) continue;
      const post = ch.meanBetween(t - sf.postWindowS, t);
      const pre = ch.meanBetween(st.suspectT - sf.preWindowS - 5, st.suspectT - 5);
      if (!Number.isFinite(post) || !Number.isFinite(pre)) continue;
      used.push(this.sensors.get(ch.sensorId)!);
      dr.push(post - pre);
      const floor = 2 * this.det.sigmaFloor[ch.kind];
      w.push(1 / ((ch.sigma * ch.sigma) / sf.postWindowS + floor * floor));
    }
    if (used.length < 2) return;
    const mbl = this.mbLeak();
    this.lastFit = steadySensitivityFit(net, model, used, dr, w, {
      coarseStepM: sf.coarseStepM,
      fineStepM: sf.fineStepM,
      timeS: t,
      leakPriorKgS: Number.isFinite(mbl.kgs) && mbl.kgs > 0 ? mbl.kgs : undefined,
      leakPriorSigmaKgS: Number.isFinite(mbl.kgs) ? Math.max(0.1, 0.2 * Math.abs(mbl.kgs)) : undefined
    });
  }

  // ------------------------------------------------------------------ features

  computeFeatures(t: number): FeatureVector {
    const W = this.det.featureWindowS;
    const c = this.det.d1;
    const pch = this.pressureChannels(this.resAdapt);
    const zs = pch.map((ch) => ch.meanZ(10));
    const absZ = zs.map(Math.abs).sort((a, b) => b - a);
    const strongestIdx = zs.reduce((bi, z, i) => (Math.abs(z) > Math.abs(zs[bi] ?? 0) ? i : bi), 0);
    const strongestSign = Math.sign(zs[strongestIdx] ?? 0);
    const dev = zs.filter((z) => Math.abs(z) > 3);
    const fchans = [...this.resAdapt.values()].filter((ch) => ch.kind === 'massFlow' && !this.excluded.has(ch.sensorId));
    const cmds = this.commandLog.filter((e) => e.t <= t && e.t > t - W);
    let pumpChange = 0;
    let valveChange = 0;
    for (const e of cmds) {
      const prev = this.commandLog.filter((x) => x.t < e.t && x.cmd.targetId === e.cmd.targetId && x.cmd.kind === e.cmd.kind).pop();
      if (e.cmd.kind === 'pump_speed') {
        const before = prev && prev.cmd.kind === 'pump_speed' ? prev.cmd.speedRatio : this.initialPumpSpeed(e.cmd.targetId);
        pumpChange = Math.max(pumpChange, Math.abs(e.cmd.speedRatio - before));
      }
      if (e.cmd.kind === 'valve_opening') {
        const before = prev && prev.cmd.kind === 'valve_opening' ? prev.cmd.opening : this.initialValveOpening(e.cmd.targetId);
        valveChange = Math.max(valveChange, Math.abs(e.cmd.opening - before));
      }
    }
    const lastCmd = this.commandLog.filter((e) => e.t <= t).pop();
    const inl = this.inletChange(t);
    const allRes = [...this.resAdapt.values()];
    const frMissing = allRes.length ? allRes.reduce((s, ch) => s + ch.missingFracBetween(t - W, t), 0) / allRes.length : 0;
    const maxAge = Math.min(W, Math.max(0, ...allRes.map((ch) => t - ch.lastGoodT)));
    let disagree = 0;
    let nd = 0;
    for (const ch of pch) {
      const f = this.resFixed.get(ch.sensorId);
      if (!f) continue;
      disagree += Math.abs(f.meanZ(10) - ch.meanZ(10));
      nd++;
    }
    const onsetSensors = new Set(this.onsets.filter((o) => o.tS > t - W).map((o) => o.sensorId));
    let noiseRatio = 0;
    let jump = 0;
    for (const ch of pch) {
      const hr = ch.hrBetween(t - 10, t);
      if (hr.r.length > 5) {
        const m = hr.r.reduce((a, b) => a + b, 0) / hr.r.length;
        const sd = Math.sqrt(hr.r.reduce((a, b) => a + (b - m) * (b - m), 0) / (hr.r.length - 1));
        noiseRatio = Math.max(noiseRatio, sd / ch.sigmaHr);
      }
      const a = ch.meanBetween(t - 5, t);
      const b = ch.meanBetween(t - 10, t - 5);
      if (Number.isFinite(a) && Number.isFinite(b)) jump = Math.max(jump, Math.abs(a - b) / ch.sigma);
    }
    const mbl = this.mbLeak();
    const fv: FeatureVector = {
      p_neg_max_z: Math.max(0, ...zs.map((z) => -z)),
      p_pos_max_z: Math.max(0, ...zs),
      p_n_dev: dev.length,
      p_isolation: absZ.length > 1 ? absZ[0]! / (absZ[1]! + 1) : absZ[0] ?? 0,
      p_sign_consistency: dev.length ? dev.filter((z) => Math.sign(z) === strongestSign).length / dev.length : 1,
      cusum_neg_max: Math.max(0, ...pch.map((ch) => ch.sNeg / c.cusumH)),
      cusum_pos_max: Math.max(0, ...pch.map((ch) => ch.sPos / c.cusumH)),
      mb_z: Number.isFinite(mbl.z) ? mbl.z : Number.NaN,
      flow_res_max_abs_z: Math.max(0, ...fchans.map((ch) => Math.abs(ch.meanZ(10)))),
      flow_pattern: this.flowPattern(),
      pump_cmd_change: pumpChange,
      valve_cmd_change: valveChange,
      time_since_cmd: lastCmd ? Math.min(t - lastCmd.t, W) / W : 1,
      temp_change: inl.dT,
      wc_change: inl.dW,
      frac_missing: frMissing,
      max_data_age: maxAge,
      observer_disagreement: nd ? disagree / nd : 0,
      wave_onsets: onsetSensors.size,
      noise_ratio_max: noiseRatio,
      jump_max_z: jump
    };
    for (const n of FEATURE_NAMES) if (!(n in fv)) fv[n] = Number.NaN;
    return fv;
  }

  private initialPumpSpeed(id: string): number {
    const l = this.cfg.links.find((x) => x.id === id);
    return l && l.kind === 'pump' ? l.initialSpeedRatio : 1;
  }

  private initialValveOpening(id: string): number {
    const l = this.cfg.links.find((x) => x.id === id);
    return l && l.kind === 'valve' ? l.initialOpening : 1;
  }

  // ------------------------------------------------------------------ outputs

  diagnosis(id: DetectorId): Diagnosis {
    const st = this.d[id];
    const t = this.simTimeS;
    let status: DiagnosisStatus = st.state;
    const lim = [...st.limitations];
    if (!this.calibrated) {
      status = 'unavailable';
      lim.unshift(`Калибровка нормального режима до t=${this.det.warmupS} с: решения детектора ещё не выдаются.`);
    }
    if (this.status === 'error') {
      status = 'unavailable';
      lim.unshift(this.statusMessage);
    }
    const isLeak = st.cause === 'leak' && (status === 'confirmed' || status === 'suspected' || status === 'recovering');
    let candidates: CandidateEdge[] = [];
    if (isLeak) candidates = id === 'D0' ? (st.episode?.candidateEdges ?? []) : this.leakCandidates(st).candidates;
    const top = candidates[0];
    const mbl = this.mbLeak();
    const dg: Diagnosis = {
      schemaVersion: SCHEMA_VERSION,
      id: `${id}-${t.toFixed(1)}`,
      detector: id,
      detectorVersion: `${DETECTOR_VERSION}/${id}`,
      simTimeS: t,
      status,
      cause: status === 'normal' || status === 'unavailable' ? 'unknown' : st.cause,
      affectedSensorIds: st.affected,
      candidateEdges: candidates,
      evidence: st.evidence,
      limitations: lim,
      inputTimeRange: [Math.max(this.tInit || 0, t - this.det.featureWindowS), t],
      score: Number.isFinite(st.score) ? st.score : undefined,
      causeScores: id === 'D2' ? st.causeScores : undefined,
      episodeId: st.episode?.episodeId,
      firstAlarmTimeS: st.episode?.alarmS
    };
    const pointLevel = top !== undefined && top.method !== 'nearest_sensor' && top.method !== 'mass_balance_zone';
    if (pointLevel && top.estimatedDistanceM !== undefined) dg.estimatedDistanceM = top.estimatedDistanceM;
    if (pointLevel && top.intervalM) dg.intervalM = top.intervalM;
    if (id === 'D2' && this.classifier?.artifact.calibration.status === 'validated' && st.causeScores && status !== 'normal' && status !== 'unavailable') {
      const key = dg.cause === 'unknown' || dg.cause === 'composition_change' ? undefined : dg.cause;
      const p = key ? st.causeScores[key] : undefined;
      if (p !== undefined && Number.isFinite(p)) dg.calibratedProbability = p;
    }
    if (isLeak && id !== 'D0') {
      const q = Number.isFinite(mbl.kgs) && mbl.kgs > 0 ? mbl.kgs : this.lastFit?.best?.leakKgS;
      if (q !== undefined && Number.isFinite(q)) dg.estimatedLeakMassFlowKgs = q;
    }
    return dg;
  }

  diagnoses(): Record<DetectorId, Diagnosis> {
    return { D0: this.diagnosis('D0'), D1: this.diagnosis('D1'), D2: this.diagnosis('D2') };
  }

  massBalanceSummary(): Array<{ id: string; name: string; available: boolean; valueKgS: number; z: number; offsetKgS: number }> {
    return this.mb.map((m) => ({ id: m.group.id, name: m.group.name, available: m.available, valueKgS: m.value, z: m.z, offsetKgS: m.offset }));
  }

  get compiledNetwork(): CompiledNetwork | null {
    return this.adaptive.net;
  }

  /** travel time helper exposed for tests / UI */
  travelTimeTo(edgeId: string, x: number, sensorId: string): number {
    this.ensureTravel();
    const net = this.adaptive.net;
    const loc = this.locs.get(sensorId);
    const j = net?.pipeIndex.get(edgeId);
    if (!net || !this.travelD || !loc || j === undefined) return Number.NaN;
    return travelTime(net, this.travelD, j, x, loc);
  }
}

export function describeCommand(c: PublicCommand): string {
  switch (c.kind) {
    case 'pump_speed':
      return `${c.targetId}: частота ${c.speedRatio.toFixed(2)}`;
    case 'valve_opening':
      return `${c.targetId}: открытие ${c.opening.toFixed(2)}`;
    case 'boundary_pressure':
      return `${c.targetId}: давление ${(c.pressurePa / 1e5).toFixed(2)} бар`;
    case 'source_mass_flow':
      return `${c.targetId}: расход ${c.massFlowKgS.toFixed(1)} кг/с`;
  }
}
