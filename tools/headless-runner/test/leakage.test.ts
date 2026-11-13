/**
 * Information-leakage and reproducibility checks of the generator -> measurements -> diagnostics chain.
 */
import { describe, expect, it } from 'vitest';
import type { ScenarioFile } from '@pipetwin/contracts/truth';
import { TruthSimulator } from '@pipetwin/physics-core/truth';
import { FEATURE_NAMES } from '@pipetwin/diagnostics-core';
import { buildCatalog } from '../src/scenarios/catalog';
import { runScenario } from '../src/run';

function short(id: string, durationS: number, mutate?: (s: ScenarioFile) => void): ScenarioFile {
  const sc = structuredClone(buildCatalog().find((s) => s.id === id)!);
  sc.public.simulation.durationS = durationS;
  mutate?.(sc);
  return sc;
}

describe('reproducibility and absence of truth leakage', () => {
  it('same configuration and seed -> identical measurements; hidden metadata renaming changes nothing', () => {
    const a = short('leak_abrupt_e4', 300, (s) => {
      (s.truth.events[0] as { startTimeS: number }).startTimeS = 220;
    });
    const b = structuredClone(a);
    (b.truth.events[0] as { eventId: string }).eventId = 'renamed-hidden-label';
    b.name = 'другое имя';
    b.tags = ['other'];
    const ra = runScenario(a, 'run-x');
    const rb = runScenario(b, 'run-x');
    const fa = JSON.stringify(ra.features);
    const fb = JSON.stringify(rb.features);
    expect(fa).toBe(fb);
    expect(JSON.stringify(ra.finalDiagnoses)).toBe(JSON.stringify(rb.finalDiagnoses));
    expect(ra.finalDiagnoses.D1.status).toBe('confirmed');
    expect(ra.finalDiagnoses.D1.cause).toBe('leak');
  }, 120_000);

  it('a different seed changes the noise but not the physics outcome class', () => {
    const a = short('healthy_steady', 60);
    const b = short('healthy_steady', 60, (s) => (s.truth.seed = 999));
    const sa = new TruthSimulator(a, 'r').advanceTo(30);
    const sb = new TruthSimulator(b, 'r').advanceTo(30);
    expect(sa.length).toBe(sb.length);
    expect(sa.some((x, i) => x.valueSI !== sb[i]!.valueSI)).toBe(true);
  });

  it('hidden leak does not change the public topology seen by diagnostics', () => {
    const sc = short('leak_abrupt_e4', 60, (s) => ((s.truth.events[0] as { startTimeS: number }).startTimeS = 5));
    const sim = new TruthSimulator(sc, 'r');
    const before = sim.layout.pipeIds.join(',');
    sim.advanceTo(10);
    expect(sim.snapshot().leaks.length).toBe(1);
    expect(sim.layout.pipeIds.join(',')).toBe(before);
    expect(sc.public.links.map((l) => l.id).filter((id) => id.startsWith('e')).join(',')).toBe(before);
  });

  it('exported feature rows contain only public feature names', () => {
    const r = runScenario(short('healthy_steady', 200), 'r');
    expect(r.features.length).toBeGreaterThan(0);
    for (const row of r.features) expect(Object.keys(row.features).sort()).toEqual([...FEATURE_NAMES].sort());
  }, 60_000);
});
