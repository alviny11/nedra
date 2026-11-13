import type { MeasurementSample, PublicCommand, PublicScenarioConfig, SensorConfig } from '@pipetwin/contracts';
import {
  applyCommandToControls,
  buildTransientModel,
  compileProbe,
  controlsFromConfig,
  evaluateProbe,
  SensorResponse,
  type CompiledNetwork,
  type SensorProbe,
  type TransientNetwork
} from '@pipetwin/physics-core';
import type { DetectorConfig } from './config';

/**
 * Independent physical observer of the NORMAL regime. It knows only the public geometry, the fluid
 * passport, public commands and the measurements of sensors whose role is 'boundary_input'.
 * No leak is ever present in its model. Two property modes are used:
 *  - 'fixed': viscosity frozen at passport reference T and Y_w (baseline D0)
 *  - 'measured': transports measured inlet T and water cut, viscosity follows them (D1/D2)
 */
export type ObserverMode = 'fixed' | 'measured';

interface BoundaryChannel {
  sensor: SensorConfig;
  node: number;
  kind: 'pressure' | 'massFlow' | 'temperature' | 'waterFraction';
  tau: number;
  ts: number[];
  fs: number[];
  filtered: number | null;
  lastTs: number;
  lastGoodTs: number;
  initSum: number;
  initCount: number;
}

interface PredictionChannel {
  sensor: SensorConfig;
  probe: SensorProbe;
  response: SensorResponse;
}

export class PhysicsObserver {
  readonly mode: ObserverMode;
  readonly cfg: PublicScenarioConfig;
  private readonly det: DetectorConfig;
  net: CompiledNetwork | null = null;
  model: TransientNetwork | null = null;
  private readonly channels: BoundaryChannel[] = [];
  private readonly predictions = new Map<string, PredictionChannel>();
  private pendingCommands: PublicCommand[] = [];
  private lastCommandTime = Number.NEGATIVE_INFINITY;
  error: { code: string; message: string; simTimeS: number } | null = null;

  constructor(cfg: PublicScenarioConfig, mode: ObserverMode, det: DetectorConfig) {
    this.cfg = cfg;
    this.mode = mode;
    this.det = det;
    const nodeIds = cfg.nodes.map((n) => n.id);
    for (const s of cfg.sensors) {
      if (s.role !== 'boundary_input' || s.availability !== 'online' || !s.boundaryNodeId) continue;
      const node = nodeIds.indexOf(s.boundaryNodeId);
      if (node < 0) continue;
      if (s.kind === 'volumeFlow') continue;
      if (mode === 'fixed' && (s.kind === 'temperature' || s.kind === 'waterFraction')) continue;
      this.channels.push({
        sensor: s,
        node,
        kind: s.kind,
        tau: det.boundaryFilterTauS[s.kind],
        ts: [],
        fs: [],
        filtered: null,
        lastTs: Number.NEGATIVE_INFINITY,
        lastGoodTs: Number.NEGATIVE_INFINITY,
        initSum: 0,
        initCount: 0
      });
    }
    for (const c of cfg.commands) this.addCommand(c);
  }

  get initialized(): boolean {
    return this.model !== null;
  }

  get time(): number {
    return this.model?.t ?? 0;
  }

  addCommand(cmd: PublicCommand): void {
    this.pendingCommands.push(cmd);
    this.pendingCommands.sort((a, b) => a.simTimeS - b.simTimeS);
  }

  get lastCommandTimeS(): number {
    return this.lastCommandTime;
  }

  /** feed any measurement; only boundary inputs of this observer are used */
  ingest(s: MeasurementSample): void {
    for (const ch of this.channels) {
      if (ch.sensor.id !== s.sensorId) continue;
      ch.lastTs = Math.max(ch.lastTs, s.simTimeS);
      if (s.valueSI === null || s.quality === 'invalid' || s.quality === 'missing') continue;
      let v = s.valueSI - ch.sensor.biasSI;
      if (!this.model) {
        ch.initSum += v;
        ch.initCount++;
      }
      if (ch.filtered === null) ch.filtered = v;
      else {
        const dt = Math.max(0, s.simTimeS - ch.lastGoodTs);
        const a = ch.tau > 0 ? 1 - Math.exp(-dt / ch.tau) : 1;
        ch.filtered += a * (v - ch.filtered);
      }
      v = ch.filtered;
      ch.lastGoodTs = s.simTimeS;
      ch.ts.push(s.simTimeS);
      ch.fs.push(v);
      if (ch.ts.length > 256) {
        ch.ts.splice(0, 128);
        ch.fs.splice(0, 128);
      }
    }
  }

  /** time up to which the fast hydraulic boundary inputs are available */
  availableTime(): number {
    let t = Number.POSITIVE_INFINITY;
    let any = false;
    for (const ch of this.channels) {
      if (ch.kind !== 'pressure' && ch.kind !== 'massFlow') continue;
      if (!Number.isFinite(ch.lastTs)) continue;
      any = true;
      t = Math.min(t, ch.lastTs);
    }
    return any ? t : Number.NEGATIVE_INFINITY;
  }

  boundaryAgeS(t: number): number {
    let age = 0;
    for (const ch of this.channels) age = Math.max(age, t - ch.lastGoodTs);
    return age;
  }

  private channelValue(ch: BoundaryChannel, t: number): number | null {
    const n = ch.ts.length;
    if (n === 0) return null;
    if (t >= ch.ts[n - 1]!) return ch.fs[n - 1]!;
    for (let k = n - 1; k > 0; k--) {
      if (ch.ts[k - 1]! <= t) {
        const w = (t - ch.ts[k - 1]!) / (ch.ts[k]! - ch.ts[k - 1]!);
        return ch.fs[k - 1]! + w * (ch.fs[k]! - ch.fs[k - 1]!);
      }
    }
    return ch.fs[0]!;
  }

  /** convert a measured water VOLUME fraction to the model's mass fraction at boundary node */
  private toMassFraction(net: CompiledNetwork, node: number, alpha: number, T: number, p: number): number {
    const e = net.nodes[node]!.ends[0];
    if (!e) return alpha;
    const fl = net.pipes[e.pipe]!.fluid;
    const a = Math.min(Math.max(alpha, 0), 1);
    return fl.waterMassFractionFromVolume(a, p, T);
  }

  initialize(tInit: number): void {
    const built = buildTransientModel(this.cfg, {
      viscosityMode: this.mode === 'fixed' ? 'fixed_reference' : 'transported',
      transport: this.mode !== 'fixed',
      controls: (net) => {
        const ctl = controlsFromConfig(this.cfg, net, tInit);
        if (this.mode === 'fixed') {
          net.nodes.forEach((nd, i) => {
            const e = nd.ends[0];
            if (!e) return;
            const pr = net.pipes[e.pipe]!.fluid.profile;
            ctl.boundary.temperatureK[i] = pr.referenceTemperatureK;
            ctl.boundary.waterMassFraction[i] = pr.referenceWaterMassFraction;
          });
        }
        for (const ch of this.channels) {
          if (ch.initCount === 0) continue;
          const v = ch.initSum / ch.initCount;
          if (ch.kind === 'pressure') ctl.boundary.pressurePa[ch.node] = v;
          else if (ch.kind === 'massFlow') ctl.boundary.massFlowKgS[ch.node] = v;
          else if (ch.kind === 'temperature') ctl.boundary.temperatureK[ch.node] = v;
        }
        for (const ch of this.channels) {
          if (ch.kind !== 'waterFraction' || ch.initCount === 0) continue;
          const i = ch.node;
          ctl.boundary.waterMassFraction[i] = this.toMassFraction(net, i, ch.initSum / ch.initCount, ctl.boundary.temperatureK[i]!, ctl.boundary.pressurePa[i] || 5e5);
        }
        return ctl;
      }
    });
    this.net = built.net;
    this.model = built.model;
    this.model.t = tInit;
    this.pendingCommands = this.pendingCommands.filter((c) => c.simTimeS > tInit);
    for (const s of this.cfg.sensors) {
      if (s.availability !== 'online') continue;
      const probe = compileProbe(this.net, s);
      const response = new SensorResponse(s.timeConstantS, 30, this.net.dt);
      response.reset(tInit, evaluateProbe(this.model, probe));
      this.predictions.set(s.id, { sensor: s, probe, response });
    }
  }

  /** advance the observer model to time t using filtered boundary inputs (causal) */
  advanceTo(t: number): void {
    const m = this.model;
    const net = this.net;
    if (!m || !net || this.error) return;
    const dt = m.dt;
    const pressureNodes = new Set<number>();
    while (m.t + dt <= t + 1e-9) {
      const t1 = m.t + dt;
      while (this.pendingCommands.length && this.pendingCommands[0]!.simTimeS <= t1 + 1e-12) {
        const c = this.pendingCommands.shift()!;
        this.lastCommandTime = c.simTimeS;
        if (c.kind === 'pump_speed') m.pumpCommand[net.deviceIndex.get(c.targetId)!] = c.speedRatio;
        else if (c.kind === 'valve_opening') m.valveCommand[net.deviceIndex.get(c.targetId)!] = c.opening;
        else {
          applyCommandToControls(net, c, {
            boundary: { pressurePa: m.bcPressure, massFlowKgS: m.bcMassFlow, temperatureK: m.bcTemperature, waterMassFraction: m.bcWaterFraction },
            pumpSpeed: m.pumpCommand,
            valveOpening: m.valveCommand,
            ambientK: m.ambientK
          });
        }
      }
      pressureNodes.clear();
      for (const ch of this.channels) {
        const v = this.channelValue(ch, t1);
        if (v === null) continue;
        switch (ch.kind) {
          case 'pressure':
            m.bcPressure[ch.node] = v;
            break;
          case 'massFlow':
            m.bcMassFlow[ch.node] = Math.max(0, v);
            break;
          case 'temperature':
            m.bcTemperature[ch.node] = v;
            break;
          case 'waterFraction':
            m.bcWaterFraction[ch.node] = this.toMassFraction(net, ch.node, v, m.bcTemperature[ch.node]!, m.bcPressure[ch.node] || 5e5);
            break;
        }
      }
      try {
        m.step();
      } catch (e) {
        const err = e as { code?: string; message?: string };
        this.error = { code: err.code ?? 'NUMERICAL_DIVERGENCE', message: err.message ?? String(e), simTimeS: m.t };
        return;
      }
      for (const pc of this.predictions.values()) pc.response.update(m.t, evaluateProbe(m, pc.probe));
    }
  }

  /** predicted sensor reading (through the public instrument response) at time t <= model time */
  predict(sensorId: string, t: number): number | null {
    const pc = this.predictions.get(sensorId);
    if (!pc || !this.model) return null;
    if (t > this.model.t + 1e-9) return null;
    return pc.response.valueAt(t - pc.sensor.delayS) + pc.sensor.biasSI;
  }

  /** instantaneous model value at a sensor location (no instrument filter) */
  fieldAt(sensorId: string): number | null {
    const pc = this.predictions.get(sensorId);
    if (!pc || !this.model) return null;
    return evaluateProbe(this.model, pc.probe);
  }

  /** linearised liquid inventory over pipe segments [kg] (consistent with the acoustic model) */
  segmentInventory(segments: Array<{ edgeId: string; fromM: number; toM: number }>): number {
    const m = this.model;
    const net = this.net;
    if (!m || !net) return 0;
    let M = 0;
    for (const seg of segments) {
      const j = net.pipeIndex.get(seg.edgeId);
      if (j === undefined) continue;
      const pp = net.pipes[j]!;
      const n = 200;
      const L = Math.max(0, seg.toM - seg.fromM);
      if (L <= 0) continue;
      const h = L / n;
      let s = 0;
      for (let k = 0; k <= n; k++) {
        const x = seg.fromM + k * h;
        const fi = Math.min(pp.n - 1, Math.floor(x / pp.dx));
        const w = x / pp.dx - fi;
        const p = (1 - w) * m.p[pp.offset + fi]! + w * m.p[pp.offset + fi + 1]!;
        const wt = k === 0 || k === n ? 0.5 : 1;
        s += wt * (pp.A * p) / (pp.c * pp.c);
      }
      M += s * h + pp.rho * pp.A * L;
    }
    return M;
  }

  /** current boundary input values seen by the model (for UI / features) */
  boundaryInputs(): Array<{ sensorId: string; kind: string; value: number | null; ageS: number }> {
    const t = this.time;
    return this.channels.map((ch) => ({ sensorId: ch.sensor.id, kind: ch.kind, value: ch.filtered, ageS: t - ch.lastGoodTs }));
  }
}
