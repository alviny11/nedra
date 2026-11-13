"""Shared fixtures: Python (Pydantic + semantic validation) must accept/reject exactly like the TS side
(Ajv against the exported JSON schema + validateScenario), see packages/physics-core/test/fixtures.test.ts."""
import json

import pytest
from pydantic import ValidationError

from app.schemas.domain import EXPORTED_SCHEMAS, PublicScenarioConfig, ScenarioFile
from app.services.validation import validate_public_scenario
from tests.conftest import FIXTURES, REPO

EXPECT = json.loads((FIXTURES / "expectations.json").read_text())


def python_accepts(path) -> bool:
    raw = json.loads(path.read_text())
    try:
        if "public" in raw:
            cfg = ScenarioFile.model_validate(raw).public
        else:
            cfg = PublicScenarioConfig.model_validate(raw)
    except ValidationError:
        return False
    return validate_public_scenario(cfg).ok


@pytest.mark.parametrize("name,expected", sorted(EXPECT.items()))
def test_fixture_expectation(name, expected):
    assert python_accepts(FIXTURES / name) == (expected == "valid")


def test_exported_schemas_are_current():
    out = REPO / "packages" / "contracts" / "schemas"
    for name, model in EXPORTED_SCHEMAS.items():
        on_disk = json.loads((out / f"{name}.schema.json").read_text())
        assert on_disk == json.loads(json.dumps(model.model_json_schema())), f"{name}.schema.json is stale: run python -m pipetwin_ml.cli schemas"


def test_all_bundled_scenarios_validate():
    for p in (REPO / "data" / "scenarios").glob("*.json"):
        if p.name == "index.json":
            continue
        sc = ScenarioFile.model_validate_json(p.read_text())
        assert validate_public_scenario(sc.public).ok, p.name
