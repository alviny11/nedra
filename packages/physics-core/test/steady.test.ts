import { describe, expect, it } from 'vitest';
import { buildTransientModel, G, validateScenario } from '../src';
import { node, pipe, scenario, waterWithModulus, waterConst } from './helpers';

function colebrookBisect(re: number, rr: number): number {
  let lo = 0.003;
  let hi = 0.3;
  for (let i = 0; i < 200; i++) {
    const f = 0.5 * (lo + hi);
    const g = 1 / Math.sqrt(f) + 2 * Math.log10(rr / 3.7 + 2.51 / (re * Math.sqrt(f)));
    if (g > 0) lo = f;
    else hi = f;
  }
  return 0.5 * (lo + hi);
}

describe('steady network solver', () => {
  it('laminar pipe follows Hagen-Poiseuille within 1%', () => {
    const fl = { ...waterWithModulus(2.19e9, 0.1), id: 'water_const' };
    const cfg = scenario(
      [node('A', 'pressure_boundary', 0, { pressurePa: 2e5 }), node('B', 'pressure_boundary', 0, { pressurePa: 1e5 })],
      [pipe('p', 'A', 'B', 100, 0.01, 0, 0)],
      { fluids: [fl], settings: { targetReachLengthM: 5 } }
    );
    const { steady } = buildTransientModel(cfg, { viscosityMode: 'transported', transport: false });
    const Q = steady.pipeMassFlow[0]! / 1000;
    const Qref = (Math.PI * 0.01 ** 4 * 1e5) / (128 * 0.1 * 100);
    expect(Math.abs(Q / Qref - 1)).toBeLessThan(0.01);
  });

  it('turbulent pipe matches an independent Darcy-Colebrook calculation within 1%', () => {
    const cfg = scenario(
      [node('A', 'pressure_boundary', 0, { pressurePa: 5e5 }), node('B', 'pressure_boundary', 0, { pressurePa: 3e5 })],
      [pipe('p', 'A', 'B', 1000, 0.2, 0, 0, { roughnessM: 4.5e-5 })],
      { fluids: [waterWithModulus(2.19e9, 1e-3)].map((f) => ({ ...f, id: 'water_const' })) }
    );
    const { steady } = buildTransientModel(cfg, { viscosityMode: 'transported', transport: false });
    const m = steady.pipeMassFlow[0]!;
    const u = m / (1000 * Math.PI * 0.01);
    const re = (1000 * u * 0.2) / 1e-3;
    const f = colebrookBisect(re, 4.5e-5 / 0.2);
    const dpRef = ((f * 1000) / 0.2) * ((1000 * u * u) / 2);
    expect(re).toBeGreaterThan(4000);
    expect(Math.abs(dpRef / 2e5 - 1)).toBeLessThan(0.01);
  });

  it('keeps hydrostatic equilibrium with relief (no spurious flow, p + rho g z constant)', () => {
    const p = pipe('p', 'A', 'B', 2000, 0.3, 0, 30, {
      elevationProfile: [
        { distanceM: 0, elevationM: 0 },
        { distanceM: 700, elevationM: 55 },
        { distanceM: 1300, elevationM: 12 },
        { distanceM: 2000, elevationM: 30 }
      ]
    });
    const cfg = scenario([node('A', 'pressure_boundary', 0, { pressurePa: 20e5 }), node('B', 'closed_end', 30)], [p], {
      fluids: [{ ...waterWithModulus(2.19e9), id: 'water_const' }]
    });
    const { model, net } = buildTransientModel(cfg, { viscosityMode: 'transported', transport: true });
    const rho = net.pipes[0]!.rho;
    const head0 = Array.from(model.p).map((pp, i) => pp + rho * G * net.zPt[i]!);
    for (let s = 0; s < 2000; s++) model.step();
    let maxU = 0;
    let maxDev = 0;
    for (let i = 0; i < net.nPoints; i++) {
      maxU = Math.max(maxU, Math.abs(model.uR[i]!), Math.abs(model.uL[i]!));
      maxDev = Math.max(maxDev, Math.abs(model.p[i]! + rho * G * net.zPt[i]! - head0[0]!));
    }
    expect(maxU).toBeLessThan(1e-9);
    expect(maxDev).toBeLessThan(1e-4);
    expect(Math.abs(head0[head0.length - 1]! - head0[0]!)).toBeLessThan(1e-6);
  });

  it('solves a tee with a source: nodal mass balance and link equations hold', () => {
    const cfg = scenario(
      [
        node('A', 'pressure_boundary', 0, { pressurePa: 6e5 }),
        node('J', 'junction', 5),
        node('B', 'pressure_boundary', 2, { pressurePa: 3e5 }),
        node('S', 'mass_flow_source', 10, { massFlowKgS: 12 })
      ],
      [pipe('a', 'A', 'J', 1500, 0.25, 0, 5, { roughnessM: 4.5e-5 }), pipe('b', 'J', 'B', 2000, 0.25, 5, 2, { roughnessM: 4.5e-5 }), pipe('c', 'S', 'J', 800, 0.1, 10, 5, { roughnessM: 4.5e-5 })],
      { fluids: [{ ...waterWithModulus(2.19e9), id: 'water_const' }] }
    );
    const { steady, net } = buildTransientModel(cfg, { viscosityMode: 'transported', transport: false });
    const [ma, mb, mc] = steady.pipeMassFlow;
    const rho = net.pipes[1]!.rho;
    expect(Math.abs(ma! + mc! - mb!)).toBeLessThan(1e-8);
    expect(mc!).toBeCloseTo(12, 8);
    // independent check of link 'b' equation
    const pJ = steady.nodeP[1]!;
    const u = mb! / (rho * Math.PI * 0.25 ** 2 / 4);
    const f = colebrookBisect((rho * Math.abs(u) * 0.25) / 1e-3, 4.5e-5 / 0.25);
    const dp = rho * G * (2 - 5) + ((f * 2000) / 0.25) * (rho * u * Math.abs(u)) / 2;
    expect(Math.abs(pJ - 3e5 - dp) / Math.abs(dp)).toBeLessThan(1e-6);
  });

  it('rejects ill-posed inputs with specific reasons', () => {
    const noPressure = scenario([node('A', 'mass_flow_source', 0, { massFlowKgS: 1 }), node('B', 'closed_end', 0)], [pipe('p', 'A', 'B', 100, 0.1, 0, 0)]);
    const r1 = validateScenario(noPressure);
    expect(r1.ok).toBe(false);
    expect(r1.errors.some((e) => e.code === 'INVALID_TOPOLOGY' && e.message.includes('no pressure boundary'))).toBe(true);

    const badSensor = scenario([node('A', 'pressure_boundary', 0, { pressurePa: 2e5 }), node('B', 'closed_end', 0)], [pipe('p', 'A', 'B', 100, 0.1, 0, 0)], {
      sensors: [
        {
          id: 's',
          name: 's',
          kind: 'pressure',
          edgeId: 'nope',
          distanceM: 1,
          sampleRateHz: 10,
          timeConstantS: 0,
          delayS: 0,
          noiseStdSI: 0,
          biasSI: 0,
          quantizationStepSI: 0,
          dropoutProbability: 0,
          timestampJitterS: 0,
          rangeSI: [0, 1e7],
          role: 'residual',
          availability: 'online'
        }
      ]
    });
    expect(validateScenario(badSensor).errors.some((e) => e.fieldPath === 'sensors[0].edgeId')).toBe(true);

    const hot = scenario([node('A', 'pressure_boundary', 0, { pressurePa: 2e5, temperatureK: 400 }), node('B', 'closed_end', 0)], [pipe('p', 'A', 'B', 100, 0.1, 0, 0)], {
      fluids: [waterConst()]
    });
    expect(validateScenario(hot).errors.some((e) => e.code === 'PROFILE_OUT_OF_RANGE')).toBe(true);
  });
});
