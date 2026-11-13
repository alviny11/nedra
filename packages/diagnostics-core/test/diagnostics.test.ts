import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogisticModelArtifact } from '@pipetwin/contracts';
import { buildTopology, discretize, pipeWaveSpeed } from '@pipetwin/physics-core';
import {
  ResidualChannel,
  detectNegativeOnset,
  straightPipeEstimate,
  nodeTravelTimes,
  sensorLocations,
  travelTime,
  localizeByArrivals,
  LogisticClassifier,
  FEATURE_NAMES,
  median,
  robustSigma
} from '../src';
import { buildDemoPublic } from '../../../tools/headless-runner/src/scenarios/demoField';

const SRC = join(__dirname, '..', 'src');

describe('architectural independence from truth', () => {
  it('diagnostics-core sources never import truth modules or truth types', () => {
    const forbidden = [/contracts\/truth/, /physics-core\/truth/, /TruthConfig/, /LeakEvent/, /GroundTruth/, /TruthSimulator/, /SensorFaultEvent/];
    for (const f of readdirSync(SRC)) {
      // strip comments: only code (imports, identifiers) matters
      const text = readFileSync(join(SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const re of forbidden) expect(re.test(text), `${f} matches ${re}`).toBe(false);
    }
  });
});

describe('straight-pipe arrival formula', () => {
  it('event near the left sensor arrives there first and gives x < L/2', () => {
    const L = 900;
    const c = 1300;
    const x = 200;
    const tL = x / c;
    const tR = (L - x) / c;
    expect(tL).toBeLessThan(tR);
    const est = straightPipeEstimate(L, c, tL, tR);
    expect(est).toBeCloseTo(x, 9);
    expect(est).toBeLessThan(L / 2);
  });
});

describe('robust statistics and CUSUM', () => {
  it('median / MAD sigma of a normal-like sample', () => {
    const xs = [1, 2, 3, 4, 100];
    expect(median(xs)).toBe(3);
    expect(robustSigma(xs, 3)).toBeCloseTo(1.4826, 4);
  });

  it('two-sided CUSUM accumulates a persistent negative shift and not white noise', () => {
    const ch = new ResidualChannel('s', 'pressure', 1, 1, 6, 10);
    ch.finalizeCalibration();
    ch.offset = 0;
    ch.sigma = 1;
    let s = 1;
    const rnd = () => {
      s = (s * 16807) % 2147483647;
      return (s / 2147483647) * 2 - 1;
    };
    for (let k = 0; k < 500; k++) ch.updateZ(rnd(), 0.75);
    expect(ch.sNeg).toBeLessThan(5);
    for (let k = 0; k < 20; k++) ch.updateZ(-3, 0.75);
    expect(ch.sNeg).toBeGreaterThan(40);
    ch.updateZ(Number.NaN, 0.75); // missing bins hold statistics, never inject zeros
    expect(ch.sNeg).toBeGreaterThan(40);
  });
});

describe('wave onset and arrival-time localisation', () => {
  it('detects the onset of a sharp negative step close to the true time', () => {
    const t: number[] = [];
    const r: number[] = [];
    let seed = 3;
    const noise = () => {
      seed = (seed * 48271) % 2147483647;
      return ((seed / 2147483647) * 2 - 1) * 1000;
    };
    for (let k = 0; k < 300; k++) {
      const tk = 100 + k * 0.02;
      t.push(tk);
      r.push((tk >= 103.0 ? -40000 : 0) + noise());
    }
    const on = detectNegativeOnset(t, r, 600, 2, 6, 3, 0.3, 101);
    expect(on).not.toBeNull();
    expect(Math.abs(on!.tS - 103.0)).toBeLessThan(0.03);
  });

  it('localises a synthetic event on the demo topology from exact first-arrival times', () => {
    const cfg = buildDemoPublic();
    const net = buildTopology(cfg);
    discretize(net, (pp) => pipeWaveSpeed(pp, 6e5, 318, pp.fluid.normalizeYw(0.18)).c);
    for (const pp of net.pipes) {
      const { rho, c } = pipeWaveSpeed(pp, 6e5, 318, pp.fluid.normalizeYw(0.18));
      pp.rho = rho;
      pp.c = c;
    }
    const D = nodeTravelTimes(net, (d) => net.devices[d]!.valve?.initialOpening !== 0);
    const locs = new Map(sensorLocations(net, cfg.sensors).map((l) => [l.sensorId, l]));
    const e4 = net.pipeIndex.get('e4')!;
    const t0 = 500;
    const sensors = ['PT-105', 'PT-107', 'PT-111', 'PT-104', 'PT-112'];
    const onsets = sensors.map((id) => ({ sensorId: id, tS: t0 + travelTime(net, D, e4, 1700, locs.get(id)!), amplitude: 1, sigmaS: 0.02 }));
    const res = localizeByArrivals(net, D, locs, onsets, 10, 600);
    expect(res.best?.edgeId).toBe('e4');
    expect(Math.abs(res.best!.distanceM - 1700)).toBeLessThanOrEqual(10);
    expect(Math.abs(res.best!.t0S - t0)).toBeLessThan(0.01);
  });

  it('waves are not transmitted through pressure boundaries (separator)', () => {
    const cfg = buildDemoPublic();
    const net = buildTopology(cfg);
    discretize(net, () => 1200);
    for (const pp of net.pipes) pp.c = 1200;
    const D = nodeTravelTimes(net, () => true);
    const nN = net.nodes.length;
    const sep1 = net.nodeIndex.get('sep1')!;
    const sepw = net.nodeIndex.get('sepw')!;
    const j1 = net.nodeIndex.get('j1')!;
    // oil network and water line are connected only through the separator boundaries
    expect(Number.isFinite(D[j1 * nN + sepw]!)).toBe(false);
    expect(Number.isFinite(D[j1 * nN + sep1]!)).toBe(true);
  });
});

describe('browser inference of the exported classifier', () => {
  it('reproduces softmax probabilities of a hand-computed multinomial model; missing -> mean', () => {
    const art: LogisticModelArtifact = {
      schemaVersion: '1.0.0',
      modelVersion: 't',
      featureSchemaVersion: 'features-1.0',
      kind: 'multinomial_logistic',
      classes: ['a', 'b', 'c'],
      featureNames: ['x', 'y'],
      scalerMean: [1, 2],
      scalerScale: [2, 4],
      coefficients: [
        [1, 0],
        [0, 1],
        [-1, -1]
      ],
      intercepts: [0, 0.5, -0.5],
      classMapping: {},
      missingFeaturePolicy: 'impute_scaler_mean',
      decisionThresholds: { minTopScore: 0.5 },
      calibration: { status: 'not_validated', note: '' },
      trainingMetadata: {},
      evaluationSummary: {}
    };
    const clf = new LogisticClassifier(art);
    const p = clf.predictProba([3, 2]); // z = [1, 0]
    const l = [1, 0.5, -1.5];
    const e = l.map(Math.exp);
    const s = e.reduce((a, b) => a + b, 0);
    p.forEach((v, i) => expect(v).toBeCloseTo(e[i]! / s, 12));
    const pm = clf.predictProba([Number.NaN, 2]); // z = [0, 0]
    const e2 = [0, 0.5, -0.5].map(Math.exp);
    const s2 = e2.reduce((a, b) => a + b, 0);
    pm.forEach((v, i) => expect(v).toBeCloseTo(e2[i]! / s2, 12));
    expect(FEATURE_NAMES.length).toBeGreaterThan(10);
  });
});
