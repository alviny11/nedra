"""PipeTwin local API (FastAPI). Single local user; no accounts; no server-side physics stepping.

The browser runs physics and baseline diagnostics on its own; this API stores scenarios/runs,
validates contracts, runs batch dataset / training jobs in separate processes and serves model
artifacts for in-browser inference.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Union

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import TypeAdapter, ValidationError

from .repositories.db import Database, dumps, now
from .schemas.api import (
    ApiError,
    BatchAck,
    DatasetJobRequest,
    EvaluateJobRequest,
    Health,
    JobOut,
    ModelOut,
    RunCreate,
    RunOut,
    ScenarioMeta,
    TrainJobRequest,
    ValidationResponse,
)
from .schemas.domain import (
    SCHEMA_VERSION,
    Diagnosis,
    FluidProfile,
    GroundTruthRecord,
    LogisticModelArtifact,
    MeasurementPacket,
    PublicScenarioConfig,
    ScenarioFile,
)
from .services.jobs import SAFE_ID, JobManager, list_models
from .services.validation import validate_public_scenario
from .settings import Settings, get_settings

API_VERSION = "0.1.0"


class PipeTwinError(Exception):
    def __init__(self, status: int, code: str, message: str, field_path: str | None = None, details: dict | None = None):
        self.status, self.code, self.message, self.field_path, self.details = status, code, message, field_path, details


def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or get_settings()
    db = Database(s.db_path)
    jobs = JobManager(db, s)
    app = FastAPI(title="PipeTwin API", version=API_VERSION, description="Local API of the PipeTwin prototype (synthetic data, single user).")
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    @app.middleware("http")
    async def limit_payload(request: Request, call_next):
        cl = request.headers.get("content-length")
        if cl is not None and int(cl) > s.max_payload_bytes:
            return JSONResponse(status_code=413, content=ApiError(code="PAYLOAD_TOO_LARGE", message=f"payload exceeds {s.max_payload_bytes} bytes").model_dump())
        return await call_next(request)

    @app.exception_handler(PipeTwinError)
    async def _pt_err(_req: Request, e: PipeTwinError):
        return JSONResponse(status_code=e.status, content=ApiError(code=e.code, message=e.message, fieldPath=e.field_path, details=e.details).model_dump(exclude_none=True))

    @app.exception_handler(RequestValidationError)
    async def _val_err(_req: Request, e: RequestValidationError):
        first = e.errors()[0] if e.errors() else {}
        loc = ".".join(str(x) for x in first.get("loc", []) if x != "body")
        return JSONResponse(status_code=422, content=ApiError(code="INVALID_SCHEMA", message=str(first.get("msg", "invalid request")), fieldPath=loc or None, details={"errors": len(e.errors())}).model_dump(exclude_none=True))

    def bundled_scenarios() -> dict[str, Path]:
        d = s.data_dir / "scenarios"
        return {p.stem: p for p in d.glob("*.json") if p.stem != "index"} if d.exists() else {}

    def load_scenario(sid: str) -> dict:
        if not SAFE_ID.match(sid):
            raise PipeTwinError(400, "INVALID_SCHEMA", "invalid scenario id", "id")
        rows = db.query("SELECT body FROM scenarios WHERE id=?", (sid,))
        if rows:
            return json.loads(rows[0]["body"])
        p = bundled_scenarios().get(sid)
        if p is None:
            raise PipeTwinError(404, "NOT_FOUND", f"scenario {sid} not found")
        return json.loads(p.read_text())

    # ------------------------------------------------------------------ health & capabilities
    @app.get("/api/health", response_model=Health)
    def health() -> Health:
        return Health(status="ok", version=API_VERSION, storage=s.db_path.exists(), runner=s.runner_path.exists(), modelRegistry=s.models_dir.exists(), schemaVersion=SCHEMA_VERSION)

    @app.get("/api/capabilities")
    def capabilities() -> dict:
        return {
            "solverModels": {
                "M0_liquid_moc": {"status": "supported", "mode": "fixed_acoustic_variable_viscosity", "notes": "MOC, fixed reference rho/c per pipe, viscosity from transported T and Y_w"},
                "conservative_variable_property": {"status": "not_implemented"},
                "M1_homogeneous_frozen": {"status": "experiment_only", "notes": "Wood mixture sound speed + fixed-property acoustic experiment; no gas leak model"},
                "M2_HEM": {"status": "not_implemented"},
                "drift_flux": {"status": "not_implemented"},
            },
            "leakModels": {"liquid_orifice": "supported", "ideal_gas_orifice": "formula_only", "two_phase_outflow": "not_implemented"},
            "detectors": ["D0", "D1", "D2"],
            "jobs": ["dataset", "train", "evaluate"],
            "serverPhysics": False,
        }

    @app.get("/api/fluid-profiles", response_model=list[FluidProfile])
    def fluid_profiles() -> list[dict]:
        d = s.data_dir / "profiles"
        return [json.loads(p.read_text()) for p in sorted(d.glob("*.json"))] if d.exists() else []

    # ------------------------------------------------------------------ scenarios
    @app.get("/api/scenarios", response_model=list[ScenarioMeta])
    def scenarios() -> list[ScenarioMeta]:
        out: list[ScenarioMeta] = []
        for sid, p in sorted(bundled_scenarios().items()):
            body = json.loads(p.read_text())
            out.append(ScenarioMeta(id=sid, name=body.get("name", sid), tags=body.get("tags", []), configHash=hashlib.sha256(p.read_bytes()).hexdigest()[:16], createdAt=p.stat().st_mtime, source="bundled"))
        for r in db.query("SELECT id, name, tags, config_hash, created_at FROM scenarios ORDER BY created_at"):
            out.append(ScenarioMeta(id=r["id"], name=r["name"], tags=json.loads(r["tags"]), configHash=r["config_hash"], createdAt=r["created_at"], source="saved"))
        return out

    @app.post("/api/scenarios/validate", response_model=ValidationResponse)
    def validate(body: Union[ScenarioFile, PublicScenarioConfig]) -> ValidationResponse:
        cfg = body.public if isinstance(body, ScenarioFile) else body
        r = validate_public_scenario(cfg)
        return ValidationResponse(ok=r.ok, errors=[e.__dict__ for e in r.errors], warnings=[w.__dict__ for w in r.warnings])

    @app.post("/api/scenarios", response_model=ScenarioMeta, status_code=201)
    def save_scenario(body: ScenarioFile) -> ScenarioMeta:
        r = validate_public_scenario(body.public)
        if not r.ok:
            raise PipeTwinError(422, r.errors[0].code, r.errors[0].message, r.errors[0].fieldPath, {"errors": [e.__dict__ for e in r.errors]})
        raw = dumps(body.model_dump(mode="json", exclude_none=True))
        h = hashlib.sha256(raw.encode()).hexdigest()[:16]
        t = now()
        db.execute(
            "INSERT INTO scenarios(id, name, tags, body, config_hash, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, tags=excluded.tags, body=excluded.body, config_hash=excluded.config_hash",
            (body.id, body.name, dumps(body.tags), raw, h, t),
        )
        return ScenarioMeta(id=body.id, name=body.name, tags=body.tags, configHash=h, createdAt=t, source="saved")

    @app.get("/api/scenarios/{sid}", response_model=ScenarioFile)
    def get_scenario(sid: str) -> dict:
        """Operator configuration (contains hidden truth) — for the experiment loader only."""
        return load_scenario(sid)

    @app.get("/api/scenarios/{sid}/public", response_model=PublicScenarioConfig)
    def get_scenario_public(sid: str) -> dict:
        """Only the configuration a diagnostician may see (no truth block)."""
        return load_scenario(sid)["public"]

    # ------------------------------------------------------------------ runs
    def get_run(rid: str) -> dict:
        if not SAFE_ID.match(rid):
            raise PipeTwinError(400, "INVALID_SCHEMA", "invalid run id")
        rows = db.query("SELECT * FROM runs WHERE id=?", (rid,))
        if not rows:
            raise PipeTwinError(404, "NOT_FOUND", f"run {rid} not found")
        r = rows[0]
        return {"id": r["id"], "scenarioId": r["scenario_id"], "configHash": r["config_hash"], "versions": json.loads(r["versions"]), "status": r["status"], "createdAt": r["created_at"], "finishedAt": r["finished_at"]}

    @app.post("/api/runs", response_model=RunOut, status_code=201)
    def create_run(body: RunCreate) -> dict:
        try:
            db.execute("INSERT INTO runs(id, scenario_id, config_hash, versions, status, created_at) VALUES (?,?,?,?,?,?)", (body.runId, body.scenarioId, body.configHash, dumps(body.versions), "open", now()))
        except Exception as e:  # sqlite IntegrityError
            raise PipeTwinError(409, "CONFLICT", f"run {body.runId} already exists") from e
        return get_run(body.runId)

    @app.post("/api/runs/{rid}/measurements", response_model=BatchAck)
    def post_measurements(rid: str, body: MeasurementPacket) -> BatchAck:
        get_run(rid)
        if body.runId != rid or any(x.runId != rid for x in body.samples):
            raise PipeTwinError(422, "INVALID_SCHEMA", "runId mismatch between path and samples", "runId")
        if len(body.samples) > s.max_batch_samples:
            raise PipeTwinError(413, "PAYLOAD_TOO_LARGE", "too many samples in one batch")
        seqs = [x.sequence for x in body.samples]
        key = hashlib.sha256(dumps([(x.sensorId, x.sequence) for x in body.samples]).encode()).hexdigest()[:24]
        exists = db.query("SELECT 1 FROM measurement_batches WHERE run_id=? AND batch_key=?", (rid, key))
        if exists:
            return BatchAck(runId=rid, batchKey=key, accepted=0, duplicate=True)
        db.execute(
            "INSERT INTO measurement_batches(run_id, batch_key, first_seq, last_seq, n, body, created_at) VALUES (?,?,?,?,?,?,?)",
            (rid, key, min(seqs) if seqs else None, max(seqs) if seqs else None, len(seqs), dumps(body.model_dump(mode="json", exclude_none=True)["samples"]), now()),
        )
        return BatchAck(runId=rid, batchKey=key, accepted=len(seqs), duplicate=False)

    @app.post("/api/runs/{rid}/ground-truth", status_code=201)
    def post_truth(rid: str, body: GroundTruthRecord) -> dict:
        """Evaluator channel only: never read by inference endpoints."""
        get_run(rid)
        if body.runId != rid:
            raise PipeTwinError(422, "INVALID_SCHEMA", "runId mismatch", "runId")
        db.execute("INSERT OR REPLACE INTO truth_records(run_id, body, created_at) VALUES (?,?,?)", (rid, dumps(body.model_dump(mode="json", exclude_none=True)), now()))
        db.execute("UPDATE runs SET status='complete', finished_at=? WHERE id=?", (now(), rid))
        return {"runId": rid, "stored": True}

    @app.post("/api/runs/{rid}/diagnoses", status_code=201)
    def post_diagnoses(rid: str, body: list[Diagnosis]) -> dict:
        get_run(rid)
        with db.conn() as c:
            c.executemany("INSERT INTO diagnoses(run_id, detector, sim_time, body) VALUES (?,?,?,?)", [(rid, d.detector, d.simTimeS, dumps(d.model_dump(mode="json", exclude_none=True))) for d in body])
        return {"runId": rid, "stored": len(body)}

    @app.get("/api/runs/{rid}/report")
    def run_report(rid: str) -> dict:
        run = get_run(rid)
        n = db.query("SELECT COALESCE(SUM(n),0) AS n, COUNT(*) AS b FROM measurement_batches WHERE run_id=?", (rid,))[0]
        diags = db.query("SELECT detector, body FROM diagnoses WHERE run_id=? ORDER BY sim_time", (rid,))
        last: dict[str, dict] = {}
        for d in diags:
            last[d["detector"]] = json.loads(d["body"])
        truth = db.query("SELECT body FROM truth_records WHERE run_id=?", (rid,))
        report = {
            "run": run,
            "measurements": {"samples": n["n"], "batches": n["b"]},
            "finalDiagnoses": last,
            "complete": run["status"] == "complete",
            "note": "Отчёт по одному прогону; метрики испытаний считаются только по завершённым прогонам с отдельной записью истины.",
        }
        if truth:
            report["groundTruth"] = json.loads(truth[0]["body"])
        return report

    # ------------------------------------------------------------------ jobs
    @app.post("/api/jobs/dataset", response_model=JobOut, status_code=202)
    def job_dataset(body: DatasetJobRequest) -> dict:
        if not s.runner_path.exists():
            raise PipeTwinError(503, "RUNNER_UNAVAILABLE", "headless runner bundle not built (npm run build:runner)")
        return jobs.create("dataset", body.model_dump())

    @app.post("/api/jobs/train", response_model=JobOut, status_code=202)
    def job_train(body: TrainJobRequest) -> dict:
        for d in (body.trainDatasetId, body.validationDatasetId):
            if not (s.datasets_dir / d / "manifest.json").exists():
                raise PipeTwinError(404, "NOT_FOUND", f"dataset {d} not found")
        return jobs.create("train", body.model_dump())

    @app.post("/api/jobs/evaluate", response_model=JobOut, status_code=202)
    def job_evaluate(body: EvaluateJobRequest) -> dict:
        if not (s.datasets_dir / body.datasetId / "manifest.json").exists():
            raise PipeTwinError(404, "NOT_FOUND", f"dataset {body.datasetId} not found")
        if not (s.models_dir / body.modelId / "model.json").exists():
            raise PipeTwinError(404, "NOT_FOUND", f"model {body.modelId} not found")
        return jobs.create("evaluate", body.model_dump())

    @app.get("/api/jobs/{jid}", response_model=JobOut)
    def job_get(jid: str) -> dict:
        j = jobs.get(jid) if SAFE_ID.match(jid) else None
        if j is None:
            raise PipeTwinError(404, "NOT_FOUND", f"job {jid} not found")
        return j

    @app.post("/api/jobs/{jid}/cancel", response_model=JobOut)
    def job_cancel(jid: str) -> dict:
        if not SAFE_ID.match(jid) or jobs.get(jid) is None:
            raise PipeTwinError(404, "NOT_FOUND", f"job {jid} not found")
        return jobs.cancel(jid)

    # ------------------------------------------------------------------ models
    @app.get("/api/models", response_model=list[ModelOut])
    def models() -> list[dict]:
        return list_models(s.models_dir)

    @app.get("/api/models/{mid}/artifact", response_model=LogisticModelArtifact)
    def model_artifact(mid: str) -> dict:
        if not SAFE_ID.match(mid):
            raise PipeTwinError(400, "INVALID_SCHEMA", "invalid model id")
        p = s.models_dir / mid / "model.json"
        if not p.exists():
            raise PipeTwinError(404, "NOT_FOUND", f"model {mid} not found")
        data = json.loads(p.read_text())
        try:
            TypeAdapter(LogisticModelArtifact).validate_python(data)
        except ValidationError as e:
            raise PipeTwinError(500, "MODEL_SCHEMA_MISMATCH", "stored artifact does not match the schema", details={"errors": e.error_count()}) from e
        return data

    return app


app = create_app()
