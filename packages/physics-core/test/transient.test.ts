import { describe, expect, it } from 'vitest';
import { ModelDomainError } from '@pipetwin/contracts';
import {
  buildTransientModel,
  criticalPressureRatio,
  idealGasOrificeMassFlow,
  woodSoundSpeed,
  holeArea,
  evaluateProbe,
  compileProbe
} from '../src';
import { node, pipe, pressureSensor, scenario, valve, waterWithModulus, oilWater } from './helpers';

const water = { ...waterWithModulus(2.19e9), id: 'water_const' };

/** reservoir -> pipe -> valve -> outlet reservoir (classic water-hammer benchmark layout) */
function hammerCase(target = 10) {
  return scenario(
    [
      node('R', 'pressure_boundary', 0, { pressurePa: 10e5 }),
      node('V', 'junction', 0),
      node('O', 'pressure_boundary', 0, { pressurePa: 10e5 - 1500 })
    ],
    [pipe('p', 'R', 'V', 1200, 0.3, 0, 0), valve('v', 'V', 'O', 0.3, 1, 0)],
    { fluids: [water], settings: { targetReachLengthM: target, minReachesPerPipe: 4 } }
  );
}

describe('transient MOC network', () => {
  it('preserves the initial steady state with constant boundaries', () => {
    const cfg = scenario(
      [
        node('A', 'pressure_boundary', 0, { pressurePa: 6e5 }),
        node('J', 'junction', 5),
        node('B', 'pressure_boundary', 2, { pressurePa: 3e5 }),
        node('S', 'mass_flow_source', 10, { massFlowKgS: 12 })
      ],
      [pipe('a', 'A', 'J', 1500, 0.25, 0, 5, { roughnessM: 4.5e-5 }), pipe('b', 'J', 'B', 2000, 0.25, 5, 2, { roughnessM: 4.5e-5 }), pipe('c', 'S', 'J', 800, 0.1, 10, 5, { roughnessM: 4.5e-5 })],
      { fluids: [water] }
    );
    const { model } = buildTransientModel(cfg, { viscosityMode: 'transported', transport: true });
    const p0 = model.p.slice();
    const u0 = model.uR.slice();
    for (let s = 0; s < 3000; s++) model.step();
    let dp = 0;
    let du = 0;
    for (let i = 0; i < p0.length; i++) {
      dp = Math.max(dp, Math.abs(model.p[i]! - p0[i]!));
      du = Math.max(du, Math.abs(model.uR[i]! - u0[i]!));
    }
    expect(dp).toBeLessThan(1.0); // Pa
    expect(du).toBeLessThan(1e-6);
  });

  it('instantaneous valve closure: Joukowsky rise rho*c*du and first arrival L/c (<=2%), correct reflection signs', () => {
    const cfg = hammerCase(10);
    const { model, net } = buildTransientModel(cfg, { viscosityMode: 'transported', transport: false });
    const pp = net.pipes[0]!;
    const c = pp.c;
    const rho = pp.rho;
    const u0 = model.uR[pp.offset + pp.n]!;
    const pValve0 = model.p[pp.offset + pp.n]!;
    const probe = compileProbe(net, pressureSensor('s', 'p', 300)); // 900 m from the valve
    const pS0 = evaluateProbe(model, probe);
    // close instantaneously at t=0+
    model.valveCommand[0] = 0;
    const L = pp.L;
    const tClose = model.dt; // closure effective in the first step
    const series: Array<[number, number, number]> = [];
    while (model.t < 4.6 * (L / c)) {
      model.step();
      series.push([model.t, model.p[pp.offset + pp.n]!, evaluateProbe(model, probe)]);
    }
    const dpJ = rho * c * u0;
    const jump = series[1]![1] - pValve0;
    expect(Math.abs(jump / dpJ - 1)).toBeLessThan(0.02);
    const arrival = series.find((s) => s[2] - pS0 > 0.5 * dpJ)![0] - tClose;
    expect(Math.abs(arrival / (900 / c) - 1)).toBeLessThan(0.02);
    // phase 1 (0..2L/c): valve pressure above reservoir; phase 2 (2L/c..4L/c): below (fixed-pressure reflection inverts)
    const pR = 10e5;
    const ph1 = series.filter((s) => s[0] > 0.2 * (L / c) && s[0] < 1.8 * (L / c)).map((s) => s[1] - pR);
    const ph2 = series.filter((s) => s[0] > 2.2 * (L / c) && s[0] < 3.8 * (L / c)).map((s) => s[1] - pR);
    expect(Math.min(...ph1)).toBeGreaterThan(0.8 * dpJ);
    expect(Math.max(...ph2)).toBeLessThan(-0.8 * dpJ);
  });

  it('conserves mass at a junction at every step', () => {
    const cfg = scenario(
      [node('A', 'pressure_boundary', 0, { pressurePa: 6e5 }), node('J', 'junction', 0), node('B', 'pressure_boundary', 0, { pressurePa: 3e5 }), node('C', 'pressure_boundary', 0, { pressurePa: 3.5e5 })],
      [pipe('a', 'A', 'J', 900, 0.2, 0, 0), pipe('b', 'J', 'B', 1300, 0.15, 0, 0), pipe('c', 'J', 'C', 700, 0.1, 0, 0)],
      { fluids: [water] }
    );
    const { model, net } = buildTransientModel(cfg, { viscosityMode: 'transported', transport: false });
    model.bcPressure[0] = 7e5; // pressure step at A creates a wave through the junction
    let maxImb = 0;
    for (let s = 0; s < 1500; s++) {
      model.step();
      let sum = 0;
      for (const e of net.nodes[1]!.ends) {
        const pp = net.pipes[e.pipe]!;
        const g = e.end === 0 ? pp.offset : pp.offset + pp.n;
        const uOut = e.end === 0 ? model.uR[g]! : -model.uL[g]!;
        sum += pp.rho * pp.A * uOut;
      }
      maxImb = Math.max(maxImb, Math.abs(sum));
    }
    expect(maxImb).toBeLessThan(1e-9);
  });

  it('zero-area leak does not change the solution; leak mass closes the global balance', () => {
    const mk = () =>
      buildTransientModel(
        scenario([node('A', 'pressure_boundary', 0, { pressurePa: 8e5 }), node('B', 'pressure_boundary', 0, { pressurePa: 6e5 })], [pipe('p', 'A', 'B', 2000, 0.2, 0, 0, { roughnessM: 4.5e-5 })], { fluids: [water] }),
        { viscosityMode: 'transported', transport: false }
      ).model;
    const m1 = mk();
    const m2 = mk();
    const o = m2.addOrifice({ id: 'L', pipe: 0, localPoint: 30, fullAreaM2: holeArea(0.02), cd: 0.62, pExtPa: 101325 });
    o.openFraction = 0;
    for (let s = 0; s < 500; s++) {
      m1.step();
      m2.step();
    }
    let d = 0;
    for (let i = 0; i < m1.p.length; i++) d = Math.max(d, Math.abs(m1.p[i]! - m2.p[i]!));
    expect(d).toBe(0);
    // open the leak abruptly and integrate 60 s
    o.openFraction = 1;
    const M0 = m2.inventoryKg();
    const in0 = m2.ledger.boundaryInflowKg;
    const leak0 = m2.ledger.leakOutflowKg;
    while (m2.t < 70) m2.step();
    const leaked = m2.ledger.leakOutflowKg - leak0;
    const eps = m2.inventoryKg() - M0 - (m2.ledger.boundaryInflowKg - in0 - leaked);
    expect(leaked).toBeGreaterThan(100);
    expect(Math.abs(o.cumulativeMassKg - leaked) / leaked).toBeLessThan(1e-9);
    expect(Math.abs(eps) / leaked).toBeLessThan(0.01);
    expect(Math.abs(eps) / Math.max(m2.ledger.initialInventoryKg, m2.ledger.boundaryInflowKg)).toBeLessThan(1e-4);
  });

  it('mesh refinement N, 2N, 4N: leak-induced pressure change converges (<5% between the two finest)', () => {
    const metric = (target: number): number => {
      const cfg = scenario(
        [node('A', 'pressure_boundary', 0, { pressurePa: 8e5 }), node('S', 'mass_flow_source', 0, { massFlowKgS: 40 })],
        [pipe('p', 'S', 'A', 2000, 0.2, 0, 0, { roughnessM: 4.5e-5 })],
        { fluids: [water], settings: { targetReachLengthM: target } }
      );
      const { model, net } = buildTransientModel(cfg, { viscosityMode: 'transported', transport: false });
      const pp = net.pipes[0]!;
      const o = model.addOrifice({ id: 'L', pipe: 0, localPoint: Math.round(1000 / pp.dx), fullAreaM2: holeArea(0.015), cd: 0.62, pExtPa: 101325 });
      const probe = compileProbe(net, pressureSensor('s', 'p', 400));
      const p0 = evaluateProbe(model, probe);
      o.openFraction = 1;
      while (model.t < 1.2) model.step();
      return evaluateProbe(model, probe) - p0;
    };
    const a = metric(40);
    const b = metric(20);
    const c = metric(10);
    expect(a).toBeLessThan(0);
    expect(Math.abs(c / b - 1)).toBeLessThan(0.05);
  });

  it('heat loss: outlet temperature matches the analytic exponential within 1% of dT', () => {
    const ow = { ...waterWithModulus(2.19e9), id: 'water_const' };
    const L = 2000;
    const D = 0.1;
    const U = 20;
    const Do = 0.12;
    const cfg = scenario(
      [node('S', 'mass_flow_source', 0, { massFlowKgS: 8, temperatureK: 353.15 }), node('B', 'pressure_boundary', 0, { pressurePa: 5e5, temperatureK: 293.15 })],
      [pipe('p', 'S', 'B', L, D, 0, 0, { thermal: { overallHeatTransferWm2K: U, referenceOuterDiameterM: Do, ambientTemperatureK: 283.15, insulation: 'none' } })],
      { fluids: [ow], settings: { targetReachLengthM: 25 } }
    );
    const { model, net } = buildTransientModel(cfg, { viscosityMode: 'transported', transport: true });
    // switch inlet to a new temperature and wait for 2.2 L/u
    model.bcTemperature[0] = 333.15;
    const pp = net.pipes[0]!;
    const u = 8 / (pp.rho * pp.A);
    while (model.t < (2.2 * L) / u) model.step();
    const cp = 4180;
    const Tan = 283.15 + (333.15 - 283.15) * Math.exp((-U * Math.PI * Do * L) / (8 * cp));
    const probe = compileProbe(net, { ...pressureSensor('t', 'p', L), kind: 'temperature' });
    const Tsim = evaluateProbe(model, probe);
    // outlet probe is a cell-centre interpolation half a cell upstream; compare with analytic at that x
    const xEval = L - pp.dx / 2;
    const TanX = 283.15 + (333.15 - 283.15) * Math.exp((-U * Math.PI * Do * xEval) / (8 * cp));
    expect(Math.abs(Tsim - TanX) / (333.15 - 283.15)).toBeLessThan(0.01);
    expect(Math.abs(Tan - TanX)).toBeLessThan(0.5);
  });

  it('transport: composition front arrives after ~L/u, no instantaneous change of the whole pipe, bounded', () => {
    const L = 3000;
    const cfg = scenario(
      [node('S', 'mass_flow_source', 0, { massFlowKgS: 30, temperatureK: 313.15, waterMassFraction: 0.1 }), node('B', 'pressure_boundary', 0, { pressurePa: 6e5, temperatureK: 313.15, waterMassFraction: 0.1 })],
      [pipe('p', 'S', 'B', L, 0.2, 0, 0, { fluidProfileId: 'oil_water_test' })],
      { fluids: [oilWater()], settings: { targetReachLengthM: 25 } }
    );
    const { model, net } = buildTransientModel(cfg, { viscosityMode: 'transported', transport: true });
    const pp = net.pipes[0]!;
    const u = 30 / (pp.rho * pp.A);
    model.bcWaterFraction[0] = 0.3;
    const probe = compileProbe(net, { ...pressureSensor('w', 'p', L - 10), kind: 'waterFraction' });
    const alpha0 = evaluateProbe(model, probe);
    let tHalf = -1;
    let earlyMax = 0;
    let minY = 1;
    let maxY = 0;
    const alpha1 = pp.fluid.waterVolumeFraction(0.3, 6e5, 313.15);
    while (model.t < (1.6 * L) / u) {
      model.step();
      const a = evaluateProbe(model, probe);
      if (model.t < (0.8 * L) / u) earlyMax = Math.max(earlyMax, Math.abs(a - alpha0));
      if (tHalf < 0 && a - alpha0 > 0.5 * (alpha1 - alpha0)) tHalf = model.t;
      for (let k = 0; k < net.nCells; k++) {
        minY = Math.min(minY, model.cellY[k]!);
        maxY = Math.max(maxY, model.cellY[k]!);
      }
    }
    expect(earlyMax).toBeLessThan(0.01 * (alpha1 - alpha0));
    expect(Math.abs(tHalf / ((L - 10) / u) - 1)).toBeLessThan(0.03);
    expect(minY).toBeGreaterThanOrEqual(0.1 - 1e-12);
    expect(maxY).toBeLessThanOrEqual(0.3 + 1e-12);
  });

  it('stops with UNSUPPORTED_PHASE_REGIME below the liquid limit and keeps the last valid step', () => {
    const fl = { ...waterWithModulus(2.19e9), id: 'water_const', phaseBoundaryModel: { kind: 'min_pressure' as const, minPressurePa: 2.9e5, note: 'test' } };
    const cfg = scenario([node('A', 'pressure_boundary', 0, { pressurePa: 3.2e5 }), node('B', 'pressure_boundary', 0, { pressurePa: 3.0e5 })], [pipe('p', 'A', 'B', 1000, 0.2, 0, 0)], { fluids: [fl] });
    const { model } = buildTransientModel(cfg, { viscosityMode: 'transported', transport: false });
    const o = model.addOrifice({ id: 'L', pipe: 0, localPoint: 20, fullAreaM2: holeArea(0.08), cd: 0.62, pExtPa: 101325 });
    o.openFraction = 1;
    let err: unknown = null;
    let tBefore = 0;
    let pBefore = new Float64Array();
    try {
      for (let s = 0; s < 1000; s++) {
        tBefore = model.t;
        pBefore = model.p.slice();
        model.step();
      }
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ModelDomainError);
    expect((err as ModelDomainError).code).toBe('UNSUPPORTED_PHASE_REGIME');
    expect(model.t).toBe(tBefore);
    expect(Array.from(model.p)).toEqual(Array.from(pBefore));
  });
});

describe('gas-limit formulas (reference only, not used by the M0 solver)', () => {
  it('ideal-gas orifice flow is continuous at the critical pressure ratio', () => {
    const g = 1.3;
    const rc = criticalPressureRatio(g);
    const p0 = 50e5;
    const a = idealGasOrificeMassFlow(0.8, 1e-4, p0, 320, p0 * rc * (1 - 1e-9), g, 500);
    const b = idealGasOrificeMassFlow(0.8, 1e-4, p0, 320, p0 * rc * (1 + 1e-9), g, 500);
    expect(Math.abs(a / b - 1)).toBeLessThan(1e-6);
    expect(idealGasOrificeMassFlow(0.8, 1e-4, p0, 320, p0, g, 500)).toBe(0);
  });

  it('Wood mixture speed: alpha_g -> 0 returns the liquid limit; reproduces the research example', () => {
    expect(woodSoundSpeed([{ alpha: 1, rho: 850, c: 1300 }])).toBeCloseTo(1300, 9);
    const cm = (pBar: number): number => {
      const p = pBar * 1e5;
      const rhoG = p / (500 * 320);
      const cG = Math.sqrt(1.3 * 500 * 320);
      return woodSoundSpeed([
        { alpha: 0.98, rho: 850, c: 1300 },
        { alpha: 0.02, rho: rhoG, c: cG }
      ]);
    };
    expect(cm(1)).toBeCloseTo(88, 0);
    expect(cm(10)).toBeCloseTo(273, 0);
    expect(cm(50)).toBeCloseTo(565, 0);
    expect(woodSoundSpeed([{ alpha: 1 - 1e-12, rho: 850, c: 1300 }, { alpha: 1e-12, rho: 1, c: 400 }])).toBeCloseTo(1300, 3);
  });
});
