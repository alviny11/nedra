/**
 * GENERATOR (truth) runtime. Applies hidden events (leaks, sensor faults, inlet/ambient changes,
 * boundary process noise, property deviations) to the physical model and produces measurements.
 * Only the simulation worker, the headless runner and the evaluator use this module.
 */
import type { MeasurementSample, PublicCommand, PublicScenarioConfig } from '@pipetwin/contracts';
import { ModelDomainError, SCHEMA_VERSION } from '@pipetwin/contracts';
import type {
  AmbientChangeEvent,
  GroundTruthRecord,
  InletChangeEvent,
  LeakEvent,
  SensorFaultEvent,
  TruthConfig,
  TruthEvent,
  TruthEventRealization
} from '@pipetwin/contracts/truth';
import { buildTransientModel, applyCommandToControls, controlsFromConfig, type Controls } from '../model/build';
import type { CompiledNetwork } from '../topology/compile';
import type { TransientNetwork, Orifice } from '../transient/network';
import { SensorBank, type SensorEffect } from '../sensors/sensorBank';
import { OrnsteinUhlenbeck, RandomStream } from '../numerics/rng';
import { holeArea, openAreaFraction } from '../leaks/orifice';
import { smoothRamp } from '../numerics/interp';
import { fieldSnapshot, gridLayout, type FieldSnapshot, type GridLayout } from '../transient/snapshot';

export interface TruthSimOptions {
  targetReachLengthM?: number;
}

interface Ramp {
  t0: number;
  dur: number;
  from: number;
  to: number;
}

export interface LeakStatus {
  eventId: string;
  edgeId: string;
  requestedDistanceM: number;
  appliedDistanceM: number;
  snapErrorM: number;
  massFlowKgS: number;
  cumulativeMassKg: number;
  openFraction: number;
}

export interface TruthSnapshot extends FieldSnapshot {
  leaks: LeakStatus[];
  ledger: { inventoryKg: number; initialInventoryKg: number; boundaryInflowKg: number; leakOutflowKg: number };
  activeSensorFaults: Array<{ eventId: string; sensorId: string; type: string }>;
  terminated?: { code: string; message: string; simTimeS: number };
}

export class TruthSimulator {
  readonly config: PublicScenarioConfig;
  readonly truth: TruthConfig;
  readonly runId: string;
  readonly net: CompiledNetwork;
  readonly model: TransientNetwork;
  readonly sensors: SensorBank;
  readonly layout: GridLayout;
  private readonly controls: Controls;
  private readonly setP: Float64Array;
  private readonly setM: Float64Array;
  private readonly tRamp: Array<Ramp | null>;
  private readonly yRamp: Array<Ramp | null>;
  private readonly ambRamp: Array<Ramp | null>;
  private readonly ouP: Array<OrnsteinUhlenbeck | null>;
  private readonly ouM: Array<OrnsteinUhlenbeck | null>;
  private pendingCommands: PublicCommand[];
  private pendingEvents: TruthEvent[];
  private readonly leaks: Array<{ ev: LeakEvent; orifice: Orifice; realization: TruthEventRealization }> = [];
  private readonly faults: SensorFaultEvent[] = [];
  private readonly realizations: TruthEventRealization[] = [];
  private firstLeakStart: number | null = null;
  terminated: { code: string; message: string; simTimeS: number } | null = null;

  constructor(scenario: { public: PublicScenarioConfig; truth: TruthConfig }, runId: string, opts: TruthSimOptions = {}) {
    this.config = scenario.public;
    this.truth = scenario.truth;
    this.runId = runId;
    const dev = this.truth.propertyDeviation;
    const built = buildTransientModel(this.config, {
      viscosityMode: 'transported',
      transport: true,
      fluidDeviation: { viscosityFactor: dev.viscosityFactor, bulkModulusFactor: dev.bulkModulusFactor },
      roughnessFactor: dev.roughnessFactor,
      targetReachLengthM: opts.targetReachLengthM
    });
    this.net = built.net;
    this.model = built.model;
    this.layout = gridLayout(this.net);
    this.controls = controlsFromConfig(this.config, this.net);
    this.setP = this.controls.boundary.pressurePa.slice();
    this.setM = this.controls.boundary.massFlowKgS.slice();
    this.tRamp = this.net.nodes.map(() => null);
    this.yRamp = this.net.nodes.map(() => null);
    this.ambRamp = this.net.pipes.map(() => null);
    const pn = this.truth.processNoise;
    this.ouP = this.net.nodes.map((nd) =>
      nd.kind === 'pressure' && pn.boundaryPressureStdPa > 0
        ? new OrnsteinUhlenbeck(new RandomStream(this.truth.seed, `bc-p:${nd.id}`), pn.boundaryPressureStdPa, pn.boundaryPressureTimeConstantS)
        : null
    );
    this.ouM = this.net.nodes.map((nd) =>
      nd.kind === 'source' && pn.sourceFlowRelStd > 0
        ? new OrnsteinUhlenbeck(new RandomStream(this.truth.seed, `bc-m:${nd.id}`), pn.sourceFlowRelStd, pn.sourceFlowTimeConstantS)
        : null
    );
    this.pendingCommands = this.config.commands.filter((c) => c.simTimeS > 0).sort((a, b) => a.simTimeS - b.simTimeS);
    this.pendingEvents = [...this.truth.events].sort((a, b) => a.startTimeS - b.startTimeS);
    this.sensors = new SensorBank(this.model, this.config.sensors, runId, this.truth.seed, (id, t) => this.sensorEffect(id, t));
  }

  get time(): number {
    return this.model.t;
  }

  /** live public command (operator UI); takes effect at its simTimeS (>= now) */
  enqueueCommand(cmd: PublicCommand): void {
    const c = { ...cmd, simTimeS: Math.max(cmd.simTimeS, this.model.t) };
    this.pendingCommands.push(c);
    this.pendingCommands.sort((a, b) => a.simTimeS - b.simTimeS);
  }

  /** live hidden event (operator UI); takes effect at its start time (>= now) */
  enqueueEvent(ev: TruthEvent): void {
    const e = { ...ev, startTimeS: Math.max(ev.startTimeS, this.model.t) } as TruthEvent;
    this.validateEvent(e);
    this.pendingEvents.push(e);
    this.pendingEvents.sort((a, b) => a.startTimeS - b.startTimeS);
  }

  /** nearest admissible interior grid point for a leak position */
  snapLeak(edgeId: string, distanceM: number): { pipe: number; localPoint: number; appliedDistanceM: number; snapErrorM: number } {
    const pi = this.net.pipeIndex.get(edgeId);
    if (pi === undefined) throw new ModelDomainError('UNSUPPORTED_ACTION', `Leak edge ${edgeId} is not a computed pipe`);
    const pp = this.net.pipes[pi]!;
    const k = Math.min(pp.n - 1, Math.max(1, Math.round(distanceM / pp.dx)));
    const applied = k * pp.dx;
    return { pipe: pi, localPoint: k, appliedDistanceM: applied, snapErrorM: Math.abs(applied - distanceM) };
  }

  private validateEvent(e: TruthEvent): void {
    if (e.kind === 'leak') {
      const pi = this.net.pipeIndex.get(e.edgeId);
      if (pi === undefined) throw new ModelDomainError('UNSUPPORTED_ACTION', `Leak on unknown pipe ${e.edgeId}`);
      const pp = this.net.pipes[pi]!;
      if (!(e.distanceM > 0 && e.distanceM < pp.L)) throw new ModelDomainError('UNSUPPORTED_ACTION', 'Leak position must be strictly inside the pipe');
      if (!(e.holeDiameterM > 0 && e.holeDiameterM < 0.5 * pp.D)) throw new ModelDomainError('UNSUPPORTED_ACTION', 'Hole diameter must be positive and below half the pipe bore');
      if (!(e.dischargeCoefficient > 0 && e.dischargeCoefficient <= 1)) throw new ModelDomainError('UNSUPPORTED_ACTION', 'Cd must be in (0,1]');
      if (!(e.openingDurationS >= 0)) throw new ModelDomainError('UNSUPPORTED_ACTION', 'Opening duration must be >= 0');
      if (this.leaks.some((l) => l.orifice.pipe === pi && l.orifice.localPoint === this.snapLeak(e.edgeId, e.distanceM).localPoint)) {
        throw new ModelDomainError('UNSUPPORTED_ACTION', 'A leak already exists at this grid point');
      }
    }
    if (e.kind === 'sensor_fault' && !this.config.sensors.some((s) => s.id === e.sensorId)) {
      throw new ModelDomainError('UNSUPPORTED_ACTION', `Unknown sensor ${e.sensorId}`);
    }
    if (e.kind === 'inlet_change' && this.net.nodeIndex.get(e.nodeId) === undefined) {
      throw new ModelDomainError('UNSUPPORTED_ACTION', `Unknown node ${e.nodeId}`);
    }
  }

  private sensorEffect(sensorId: string, t: number): SensorEffect | null {
    let eff: SensorEffect | null = null;
    for (const f of this.faults) {
      if (f.sensorId !== sensorId || t < f.startTimeS || (f.endTimeS !== undefined && t > f.endTimeS)) continue;
      eff ??= { biasSI: 0, stuck: false, noiseFactor: 1 };
      switch (f.fault.type) {
        case 'bias_step':
          eff.biasSI += f.fault.biasSI;
          break;
        case 'drift':
          eff.biasSI += f.fault.rateSIPerS * (t - f.startTimeS);
          break;
        case 'stuck':
          eff.stuck = true;
          break;
        case 'noise_increase':
          eff.noiseFactor *= f.fault.factor;
          break;
        case 'dropout':
          eff.dropoutProbability = f.fault.probability;
          break;
      }
    }
    return eff;
  }

  private activate(e: TruthEvent): void {
    const t = this.model.t;
    switch (e.kind) {
      case 'leak': {
        const s = this.snapLeak(e.edgeId, e.distanceM);
        const pp = this.net.pipes[s.pipe]!;
        const orifice = this.model.addOrifice({
          id: e.eventId,
          pipe: s.pipe,
          localPoint: s.localPoint,
          fullAreaM2: holeArea(e.holeDiameterM),
          cd: e.dischargeCoefficient,
          pExtPa: e.externalPressurePa
        });
        const r: TruthEventRealization = {
          eventId: e.eventId,
          kind: 'leak',
          startTimeS: e.startTimeS,
          edgeId: e.edgeId,
          requestedDistanceM: e.distanceM,
          appliedDistanceM: s.appliedDistanceM,
          snapErrorM: s.snapErrorM,
          holeDiameterM: e.holeDiameterM,
          openingDurationS: e.openingDurationS,
          detail: { gridDxM: pp.dx }
        };
        this.leaks.push({ ev: e, orifice, realization: r });
        this.realizations.push(r);
        this.firstLeakStart = this.firstLeakStart === null ? e.startTimeS : Math.min(this.firstLeakStart, e.startTimeS);
        break;
      }
      case 'sensor_fault':
        this.faults.push(e);
        this.realizations.push({ eventId: e.eventId, kind: 'sensor_fault', startTimeS: e.startTimeS, endTimeS: e.endTimeS, sensorId: e.sensorId, detail: { ...e.fault } });
        break;
      case 'inlet_change': {
        const i = this.net.nodeIndex.get(e.nodeId)!;
        if (e.temperatureK !== undefined) this.tRamp[i] = { t0: e.startTimeS, dur: e.rampDurationS, from: this.model.bcTemperature[i]!, to: e.temperatureK };
        if (e.waterMassFraction !== undefined) this.yRamp[i] = { t0: e.startTimeS, dur: e.rampDurationS, from: this.model.bcWaterFraction[i]!, to: e.waterMassFraction };
        this.realizations.push({ eventId: e.eventId, kind: 'inlet_change', startTimeS: e.startTimeS, nodeId: e.nodeId, detail: { temperatureK: e.temperatureK, waterMassFraction: e.waterMassFraction, rampDurationS: e.rampDurationS } });
        break;
      }
      case 'ambient_change': {
        const ev = e as AmbientChangeEvent;
        for (const id of ev.edgeIds) {
          const j = this.net.pipeIndex.get(id);
          if (j !== undefined) this.ambRamp[j] = { t0: ev.startTimeS, dur: ev.rampDurationS, from: this.model.ambientK[j]!, to: ev.ambientTemperatureK };
        }
        this.realizations.push({ eventId: e.eventId, kind: 'ambient_change', startTimeS: e.startTimeS, detail: { edgeIds: ev.edgeIds, ambientTemperatureK: ev.ambientTemperatureK } });
        break;
      }
    }
    void t;
  }

  /** advance in fixed solver steps while t + dt <= tTarget; returns measurement samples produced */
  advanceTo(tTarget: number, maxSteps = Number.POSITIVE_INFINITY): MeasurementSample[] {
    const out: MeasurementSample[] = [];
    if (this.terminated) return out;
    const m = this.model;
    const dt = m.dt;
    let steps = 0;
    while (m.t + dt <= tTarget + 1e-9 && steps < maxSteps) {
      const t1 = m.t + dt;
      while (this.pendingCommands.length && this.pendingCommands[0]!.simTimeS <= t1 + 1e-12) {
        const c = this.pendingCommands.shift()!;
        if (c.kind === 'pump_speed') m.pumpCommand[this.net.deviceIndex.get(c.targetId)!] = c.speedRatio;
        else if (c.kind === 'valve_opening') m.valveCommand[this.net.deviceIndex.get(c.targetId)!] = c.opening;
        else applyCommandToControls(this.net, c, { ...this.controls, boundary: { ...this.controls.boundary, pressurePa: this.setP, massFlowKgS: this.setM } });
      }
      while (this.pendingEvents.length && this.pendingEvents[0]!.startTimeS <= t1 + 1e-12) {
        this.activate(this.pendingEvents.shift()!);
      }
      for (const nd of this.net.nodes) {
        const i = nd.index;
        if (nd.kind === 'pressure') m.bcPressure[i] = this.setP[i]! + (this.ouP[i]?.step(dt) ?? 0);
        if (nd.kind === 'source') m.bcMassFlow[i] = Math.max(0, this.setM[i]! * (1 + (this.ouM[i]?.step(dt) ?? 0)));
        const tr = this.tRamp[i];
        if (tr) m.bcTemperature[i] = smoothRamp(t1, tr.t0, tr.dur, tr.from, tr.to);
        const yr = this.yRamp[i];
        if (yr) m.bcWaterFraction[i] = smoothRamp(t1, yr.t0, yr.dur, yr.from, yr.to);
      }
      this.ambRamp.forEach((r, j) => {
        if (r) m.ambientK[j] = smoothRamp(t1, r.t0, r.dur, r.from, r.to);
      });
      for (const l of this.leaks) l.orifice.openFraction = openAreaFraction(t1, l.ev.startTimeS, l.ev.openingDurationS);
      try {
        m.step();
      } catch (e) {
        if (e instanceof ModelDomainError) {
          this.terminated = { code: e.code, message: e.message, simTimeS: m.t };
          break;
        }
        throw e;
      }
      for (const s of this.sensors.afterStep()) out.push(s);
      steps++;
    }
    return out;
  }

  snapshot(): TruthSnapshot {
    const base = fieldSnapshot(this.model);
    return {
      ...base,
      leaks: this.leaks.map((l) => ({
        eventId: l.ev.eventId,
        edgeId: l.ev.edgeId,
        requestedDistanceM: l.ev.distanceM,
        appliedDistanceM: l.realization.appliedDistanceM!,
        snapErrorM: l.realization.snapErrorM!,
        massFlowKgS: l.orifice.massFlowKgS,
        cumulativeMassKg: l.orifice.cumulativeMassKg,
        openFraction: l.orifice.openFraction
      })),
      ledger: {
        inventoryKg: this.model.inventoryKg(),
        initialInventoryKg: this.model.ledger.initialInventoryKg,
        boundaryInflowKg: this.model.ledger.boundaryInflowKg,
        leakOutflowKg: this.model.ledger.leakOutflowKg
      },
      activeSensorFaults: this.faults
        .filter((f) => this.model.t >= f.startTimeS && (f.endTimeS === undefined || this.model.t <= f.endTimeS))
        .map((f) => ({ eventId: f.eventId, sensorId: f.sensorId, type: f.fault.type })),
      terminated: this.terminated ?? undefined
    };
  }

  groundTruth(): GroundTruthRecord {
    for (const l of this.leaks) {
      l.realization.peakLeakMassFlowKgS = l.orifice.peakMassFlowKgS;
      l.realization.totalLeakMassKg = l.orifice.cumulativeMassKg;
    }
    const duration = this.model.t;
    const normal = this.firstLeakStart === null ? duration : Math.max(0, Math.min(duration, this.firstLeakStart));
    return {
      schemaVersion: SCHEMA_VERSION,
      runId: this.runId,
      scenarioId: this.config.id,
      seed: this.truth.seed,
      durationS: duration,
      events: this.realizations.map((r) => ({ ...r })),
      normalExposureS: normal,
      propertyDeviation: this.truth.propertyDeviation,
      terminatedEarly: this.terminated ? { simTimeS: this.terminated.simTimeS, code: this.terminated.code, message: this.terminated.message } : undefined
    };
  }
}

export type { InletChangeEvent };
