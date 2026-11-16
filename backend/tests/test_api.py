import json
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings, get_settings
from tests.conftest import FIXTURES, needs_runner


@pytest.fixture()
def client(tmp_path):
    base = get_settings()
    s = Settings(
        repo_root=base.repo_root,
        data_dir=base.data_dir,
        var_dir=tmp_path,
        db_path=tmp_path / "t.sqlite",
        runner_path=base.runner_path,
        node_bin=base.node_bin,
        models_dir=tmp_path / "models",
        datasets_dir=tmp_path / "datasets",
    )
    return TestClient(create_app(s))


def scenario() -> dict:
    return json.loads((FIXTURES / "valid" / "healthy_steady.scenario.json").read_text())


def test_thickness_csv_is_the_current_forecast(client):
    r = client.get("/api/thickness/result.csv")
    assert r.status_code == 200
    expected = (get_settings().repo_root / "data/forecasts/result.csv").read_text()
    assert r.text == expected
    assert len(r.text.strip().splitlines()) == 2001
    assert r.headers["x-thickness-source"] == "forecast"
    assert r.text.startswith("id,segment_id,thickness_pred\n1250022871,0,5.926620\n")
    assert "\n1250009583,0,4.2615\n" in r.text
    assert r.text.strip().count("\n") == 2000


def test_health_and_capabilities(client):
    h = client.get("/api/health").json()
    assert h["status"] == "ok" and h["schemaVersion"] == "1.0.0"
    cap = client.get("/api/capabilities").json()
    assert cap["serverPhysics"] is False
    assert cap["solverModels"]["M2_HEM"]["status"] == "not_implemented"


def test_bundled_scenarios_and_public_view_hides_truth(client):
    lst = client.get("/api/scenarios").json()
    assert any(s["id"] == "leak_abrupt_e4" for s in lst)
    full = client.get("/api/scenarios/leak_abrupt_e4").json()
    assert full["truth"]["events"][0]["kind"] == "leak"
    pub = client.get("/api/scenarios/leak_abrupt_e4/public").json()
    assert "truth" not in pub and "events" not in json.dumps(pub)


def test_validate_and_save(client):
    r = client.post("/api/scenarios/validate", json=scenario()).json()
    assert r["ok"] is True
    bad = scenario()
    bad["public"]["sensors"][3]["edgeId"] = "e99"
    r = client.post("/api/scenarios/validate", json=bad).json()
    assert r["ok"] is False and r["errors"][0]["code"] == "INVALID_TOPOLOGY"
    sc = scenario()
    sc["id"] = "my_saved"
    m = client.post("/api/scenarios", json=sc)
    assert m.status_code == 201 and m.json()["source"] == "saved"
    assert client.get("/api/scenarios/my_saved").json()["id"] == "my_saved"
    r = client.post("/api/scenarios", json=bad)
    assert r.status_code == 422 and r.json()["code"] == "INVALID_TOPOLOGY"


def test_structural_errors_have_code_and_field_path(client):
    bad = scenario()
    bad["public"]["links"][0]["lengthM"] = -1
    r = client.post("/api/scenarios/validate", json=bad)
    assert r.status_code == 422
    body = r.json()
    assert body["code"] == "INVALID_SCHEMA" and "lengthM" in body.get("fieldPath", "")


def test_path_traversal_ids_rejected(client):
    assert client.get("/api/scenarios/..%2F..%2Fetc").status_code in (400, 404)
    assert client.get("/api/models/..%2Fx/artifact").status_code in (400, 404)


def test_runs_measurements_idempotency_truth_and_report(client):
    assert client.post("/api/runs", json={"runId": "r1", "scenarioId": "healthy_steady", "versions": {"core": "0.1.0"}}).status_code == 201
    assert client.post("/api/runs", json={"runId": "r1"}).status_code == 409
    samples = [{"runId": "r1", "sequence": i, "sensorId": "PT-105", "simTimeS": i * 0.02, "valueSI": 9.8e5, "quality": "good", "unit": "Pa", "measurementKind": "pressure"} for i in range(10)]
    samples.append({"runId": "r1", "sequence": 10, "sensorId": "PT-105", "simTimeS": 0.2, "valueSI": None, "quality": "missing", "unit": "Pa", "measurementKind": "pressure"})
    a = client.post("/api/runs/r1/measurements", json={"schemaVersion": "1.0.0", "runId": "r1", "samples": samples}).json()
    assert a["accepted"] == 11 and not a["duplicate"]
    b = client.post("/api/runs/r1/measurements", json={"schemaVersion": "1.0.0", "runId": "r1", "samples": samples}).json()
    assert b["duplicate"] and b["accepted"] == 0
    wrong = client.post("/api/runs/r1/measurements", json={"schemaVersion": "1.0.0", "runId": "r2", "samples": samples})
    assert wrong.status_code == 422
    rep = client.get("/api/runs/r1/report").json()
    assert rep["measurements"]["samples"] == 11 and rep["complete"] is False
    truth = {"schemaVersion": "1.0.0", "runId": "r1", "scenarioId": "healthy_steady", "seed": 1, "durationS": 10, "events": [], "normalExposureS": 10, "propertyDeviation": {"viscosityFactor": 1, "bulkModulusFactor": 1, "roughnessFactor": 1}}
    assert client.post("/api/runs/r1/ground-truth", json=truth).status_code == 201
    assert client.get("/api/runs/r1/report").json()["complete"] is True


def test_nan_is_rejected(client):
    raw = '{"schemaVersion":"1.0.0","runId":"r9","samples":[{"runId":"r9","sequence":0,"sensorId":"a","simTimeS":0,"valueSI":NaN,"quality":"good","unit":"Pa","measurementKind":"pressure"}]}'
    client.post("/api/runs", json={"runId": "r9"})
    r = client.post("/api/runs/r9/measurements", content=raw, headers={"content-type": "application/json"})
    assert r.status_code == 422


def test_jobs_validation_and_missing_dataset(client):
    r = client.post("/api/jobs/train", json={"trainDatasetId": "nope", "validationDatasetId": "nope2", "modelId": "m"})
    assert r.status_code == 404
    r = client.post("/api/jobs/dataset", json={"datasetId": "../evil", "count": 1, "seed": 1})
    assert r.status_code == 422
    assert client.get("/api/jobs/job-unknown").status_code == 404


@needs_runner
def test_dataset_job_runs_in_separate_process(client, tmp_path):
    j = client.post("/api/jobs/dataset", json={"datasetId": "smoke", "count": 1, "seed": 4242, "spec": "default"}).json()
    assert j["status"] in ("queued", "running")
    deadline = time.time() + 300
    while time.time() < deadline:
        j = client.get(f"/api/jobs/{j['id']}").json()
        if j["status"] in ("succeeded", "failed", "cancelled"):
            break
        time.sleep(1)
    assert j["status"] == "succeeded", j
    assert (tmp_path / "datasets" / "smoke" / "manifest.json").exists()
