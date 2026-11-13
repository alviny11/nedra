import type { MeasurementSample, SensorConfig } from '@pipetwin/contracts';
import { SENSOR_UNITS } from '@pipetwin/contracts';
import type { TransientNetwork } from '../transient/network';
import { compileProbe, evaluateProbe, type SensorProbe } from './probe';
import { SensorResponse } from './response';
import { RandomStream } from '../numerics/rng';

/** Additive/override effects applied by the generator (e.g. hidden sensor faults). Generic, no truth types. */
export interface SensorEffect {
  biasSI: number;
  stuck: boolean;
  noiseFactor: number;
  dropoutProbability?: number;
}
export type SensorEffectProvider = (sensorId: string, t: number) => SensorEffect | null;

interface SensorState {
  cfg: SensorConfig;
  probe: SensorProbe;
  response: SensorResponse;
  rng: RandomStream;
  nextIndex: number;
  nextJitter: number;
  seq: number;
  stuckValue: number | null;
}

/**
 * Measurement layer: true field -> instrument lag/delay -> bias -> noise -> quantisation ->
 * saturation -> dropout; samples are taken on the physical time axis (independent of rendering).
 */
export class SensorBank {
  private readonly states: SensorState[] = [];

  constructor(
    private readonly model: TransientNetwork,
    sensors: SensorConfig[],
    private readonly runId: string,
    seed: number,
    private readonly effects?: SensorEffectProvider
  ) {
    for (const cfg of sensors) {
      if (cfg.availability !== 'online') continue;
      const probe = compileProbe(model.net, cfg);
      const historyS = cfg.delayS + cfg.timestampJitterS + 4 * model.dt + 0.5;
      const rng = new RandomStream(seed, `sensor:${cfg.id}`);
      this.states.push({
        cfg,
        probe,
        response: new SensorResponse(cfg.timeConstantS, historyS, model.dt),
        rng,
        nextIndex: 0,
        nextJitter: 0,
        seq: 0,
        stuckValue: null
      });
    }
    this.reset();
  }

  reset(): void {
    const t = this.model.t;
    for (const st of this.states) {
      st.response.reset(t, evaluateProbe(this.model, st.probe));
      st.nextIndex = Math.ceil(t * st.cfg.sampleRateHz - 1e-9);
      st.nextJitter = this.drawJitter(st);
      st.stuckValue = null;
    }
  }

  private drawJitter(st: SensorState): number {
    const J = st.cfg.timestampJitterS;
    return J > 0 ? (2 * st.rng.uniform() - 1) * J : 0;
  }

  /** call after every model.step(); returns samples whose acquisition instant has passed */
  afterStep(): MeasurementSample[] {
    const out: MeasurementSample[] = [];
    const t1 = this.model.t;
    for (const st of this.states) {
      st.response.update(t1, evaluateProbe(this.model, st.probe));
      const cfg = st.cfg;
      for (;;) {
        const tn = st.nextIndex / cfg.sampleRateHz;
        const tAcq = tn + st.nextJitter;
        if (tAcq > t1 + 1e-12) break;
        out.push(this.makeSample(st, tn, tAcq));
        st.nextIndex++;
        st.nextJitter = this.drawJitter(st);
      }
    }
    return out;
  }

  private makeSample(st: SensorState, tn: number, tAcq: number): MeasurementSample {
    const cfg = st.cfg;
    const eff = this.effects?.(cfg.id, tAcq) ?? null;
    let v = st.response.valueAt(tAcq - cfg.delayS) + cfg.biasSI;
    // noise is always drawn (keeps the stream aligned independent of faults)
    const n = st.rng.normal();
    const u = st.rng.uniform();
    if (eff?.stuck) {
      if (st.stuckValue === null) st.stuckValue = v + (eff.biasSI ?? 0) + n * cfg.noiseStdSI;
      v = st.stuckValue;
    } else {
      st.stuckValue = null;
      v += (eff?.biasSI ?? 0) + n * cfg.noiseStdSI * (eff?.noiseFactor ?? 1);
    }
    let quality: MeasurementSample['quality'] = 'good';
    if (cfg.quantizationStepSI > 0) v = Math.round(v / cfg.quantizationStepSI) * cfg.quantizationStepSI;
    if (v < cfg.rangeSI[0]) {
      v = cfg.rangeSI[0];
      quality = 'saturated';
    } else if (v > cfg.rangeSI[1]) {
      v = cfg.rangeSI[1];
      quality = 'saturated';
    }
    const pDrop = eff?.dropoutProbability ?? cfg.dropoutProbability;
    const dropped = u < pDrop;
    return {
      runId: this.runId,
      sequence: st.seq++,
      sensorId: cfg.id,
      simTimeS: tn,
      valueSI: dropped ? null : v,
      quality: dropped ? 'missing' : quality,
      unit: SENSOR_UNITS[cfg.kind],
      measurementKind: cfg.kind
    };
  }
}
