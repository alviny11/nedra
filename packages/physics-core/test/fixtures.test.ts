/**
 * Cross-language contract check: the TS side (Ajv against the JSON Schema exported from the Pydantic
 * models + semantic validateScenario) must accept/reject the shared fixtures exactly like the Python side
 * (backend/tests/test_schemas.py).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import type { PublicScenarioConfig } from '@pipetwin/contracts';
import { validateScenario } from '../src';

const ROOT = join(__dirname, '..', '..', '..');
const FIX = join(ROOT, 'tests', 'fixtures');
const expectations = JSON.parse(readFileSync(join(FIX, 'expectations.json'), 'utf8')) as Record<string, 'valid' | 'invalid'>;
const ajv = new Ajv2020({ strict: false, allErrors: false });
const scenarioSchema = JSON.parse(readFileSync(join(ROOT, 'packages/contracts/schemas/scenario-file.schema.json'), 'utf8'));
const publicSchema = JSON.parse(readFileSync(join(ROOT, 'packages/contracts/schemas/public-scenario.schema.json'), 'utf8'));
const vScenario = ajv.compile(scenarioSchema);
const vPublic = ajv.compile(publicSchema);

function tsAccepts(name: string): boolean {
  const raw = JSON.parse(readFileSync(join(FIX, name), 'utf8')) as { public?: PublicScenarioConfig };
  const structural = raw.public ? vScenario(raw) : vPublic(raw);
  if (!structural) return false;
  const cfg = (raw.public ?? raw) as PublicScenarioConfig;
  return validateScenario(cfg).ok;
}

describe('shared contract fixtures (TS == Python)', () => {
  for (const [name, exp] of Object.entries(expectations)) {
    it(`${name} is ${exp}`, () => {
      expect(tsAccepts(name)).toBe(exp === 'valid');
    });
  }
});
