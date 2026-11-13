import { describe, expect, it } from 'vitest';
import type { GroundTruthRecord } from '@pipetwin/contracts/truth';
import { evaluate, type EvalRun } from '../src';

function truth(events: GroundTruthRecord['events'], duration = 900): GroundTruthRecord {
  return {
    schemaVersion: '1.0.0',
    runId: 'r',
    scenarioId: 's',
    seed: 1,
    durationS: duration,
    events,
    normalExposureS: duration,
    propertyDeviation: { viscosityFactor: 1, bulkModulusFactor: 1, roughnessFactor: 1 }
  };
}

const leak = (t: number) => ({ eventId: 'L', kind: 'leak' as const, startTimeS: t, edgeId: 'e4', appliedDistanceM: 1000, openingDurationS: 0 });

describe('event-level evaluation protocol', () => {
  it('matches one alarm per leak, measures latency and localisation, counts false alarms only outside leaks', () => {
    const runs: EvalRun[] = [
      {
        runId: 'a',
        scenarioId: 'x',
        truth: truth([leak(400)]),
        warmupS: 180,
        durationS: 900,
        commands: [],
        episodes: [
          { detector: 'D1', episodeId: '1', startS: 300, alarmS: 310, endS: 350, cause: 'leak', maxStatus: 'confirmed', candidateEdges: [] },
          { detector: 'D1', episodeId: '2', startS: 401, alarmS: 409, cause: 'leak', maxStatus: 'confirmed', candidateEdges: [{ edgeId: 'e4', estimatedDistanceM: 1030, method: 'wave_arrival' }] },
          { detector: 'D1', episodeId: '3', startS: 700, alarmS: 701, cause: 'leak', maxStatus: 'confirmed', candidateEdges: [] }
        ]
      },
      { runId: 'b', scenarioId: 'y', truth: truth([]), warmupS: 180, durationS: 900, commands: [], episodes: [] }
    ];
    const r = evaluate(runs, ['D1'], { responseWindowS: 180, causeWindowS: 240, bootstrap: 0, seed: 1 });
    const m = r.detectors[0]!;
    expect(m.leakEvents).toBe(1);
    expect(m.detected).toBe(1);
    expect(m.latencyMedianS).toBe(9);
    expect(m.edgeAccuracy).toBe(1);
    expect(m.distanceErrorMedianM).toBe(30);
    expect(m.falseAlarms).toBe(1); // the 310 s alarm before the leak
    expect(m.lateAlarms).toBe(1); // 701 s alarm during the active leak, not a false alarm
    expect(m.normalExposureH).toBeCloseTo((220 + 720) / 3600, 9);
  });

  it('censors an undetected leak whose response window lies beyond the end of the run; a zone is not an edge', () => {
    const runs: EvalRun[] = [
      // run stopped 2 s after the leak (model-domain stop): censored, not a miss
      { runId: 'c', scenarioId: 'x', truth: truth([leak(400)], 402), warmupS: 180, durationS: 402, commands: [], episodes: [] },
      // detected, but localised only to the balance zone that contains the true edge
      {
        runId: 'd',
        scenarioId: 'x',
        truth: truth([leak(400)]),
        warmupS: 180,
        durationS: 900,
        commands: [],
        episodes: [
          {
            detector: 'D1',
            episodeId: '9',
            startS: 405,
            alarmS: 420,
            cause: 'leak',
            maxStatus: 'confirmed',
            candidateEdges: [
              { edgeId: 'e2', intervalM: [0, 3200], method: 'mass_balance_zone' },
              { edgeId: 'e4', intervalM: [0, 2800], method: 'mass_balance_zone' }
            ]
          }
        ]
      },
      // an ordinary miss inside a complete run stays a miss
      { runId: 'e', scenarioId: 'x', truth: truth([leak(400)]), warmupS: 180, durationS: 900, commands: [], episodes: [] },
      // a late slow leak (window ends after the run) is censored for every detector even if caught;
      // its alarm is neither a detection in recall nor a false/late alarm
      {
        runId: 'f',
        scenarioId: 'x',
        truth: truth([{ ...leak(700), openingDurationS: 120 }]),
        warmupS: 180,
        durationS: 900,
        commands: [],
        episodes: [{ detector: 'D1', episodeId: '11', startS: 760, alarmS: 790, cause: 'leak', maxStatus: 'confirmed', candidateEdges: [{ edgeId: 'e4', estimatedDistanceM: 900, method: 'steady_residual_fit' }] }]
      }
    ];
    const m = evaluate(runs, ['D1'], { responseWindowS: 180, causeWindowS: 240, bootstrap: 0, seed: 1 }).detectors[0]!;
    expect(m.censoredLeakEvents).toBe(2);
    expect(m.censoredDetected).toBe(1);
    expect(m.falseAlarms + m.lateAlarms).toBe(0);
    expect(m.leakEvents).toBe(2);
    expect(m.detected).toBe(1);
    expect(m.recall).toBe(0.5);
    expect(m.edgeAccuracy).toBe(0);
    expect(m.candidateSetCoverage).toBe(1);
    expect(m.zoneLevelShare).toBe(1);
    expect(m.distanceErrorMedianM).toBeNull();
  });

  it('returns null (not 0 % or 100 %) for empty denominators', () => {
    const runs: EvalRun[] = [{ runId: 'b', scenarioId: 'y', truth: truth([]), warmupS: 180, durationS: 900, commands: [], episodes: [] }];
    const m = evaluate(runs, ['D0'], { responseWindowS: 180, causeWindowS: 240, bootstrap: 0, seed: 1 }).detectors[0]!;
    expect(m.recall).toBeNull();
    expect(m.precision).toBeNull();
    expect(m.latencyMedianS).toBeNull();
    expect(m.edgeAccuracy).toBeNull();
    expect(m.falseAlarmsPerHour).toBe(0);
  });
});
