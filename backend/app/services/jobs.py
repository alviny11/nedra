"""Long batch / ML jobs run in separate OS processes (never in the HTTP event loop).

Commands are built as argument arrays (no shell), parameters are validated before launch, and the
job state (queued/running/succeeded/failed/cancelled + progress) is persisted in SQLite.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from typing import Optional

from ..repositories.db import Database, dumps, now
from ..settings import Settings

SAFE_ID = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")


class JobManager:
    def __init__(self, db: Database, settings: Settings):
        self.db = db
        self.s = settings
        self._procs: dict[str, subprocess.Popen] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ public API
    def create(self, kind: str, params: dict) -> dict:
        job_id = f"job-{uuid.uuid4().hex[:12]}"
        argv, total = self._command(kind, params)
        self.db.execute(
            "INSERT INTO jobs(id, kind, params, status, progress, message, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (job_id, kind, dumps(params), "queued", 0.0, None, now(), now()),
        )
        t = threading.Thread(target=self._run, args=(job_id, argv, total), daemon=True)
        t.start()
        return self.get(job_id)

    def get(self, job_id: str) -> Optional[dict]:
        rows = self.db.query("SELECT * FROM jobs WHERE id=?", (job_id,))
        if not rows:
            return None
        r = rows[0]
        return {
            "id": r["id"],
            "kind": r["kind"],
            "params": json.loads(r["params"]),
            "status": r["status"],
            "progress": r["progress"],
            "message": r["message"],
            "result": json.loads(r["result"]) if r["result"] else None,
            "createdAt": r["created_at"],
            "updatedAt": r["updated_at"],
        }

    def cancel(self, job_id: str) -> Optional[dict]:
        with self._lock:
            p = self._procs.get(job_id)
        if p is not None and p.poll() is None:
            p.terminate()
        self._update(job_id, status="cancelled", message="cancelled by user")
        return self.get(job_id)

    # ------------------------------------------------------------------ internals
    def _command(self, kind: str, p: dict) -> tuple[list[str], int]:
        py = sys.executable
        if kind == "dataset":
            ds = p["datasetId"]
            if not SAFE_ID.match(ds):
                raise ValueError("invalid datasetId")
            out = self.s.datasets_dir / ds
            argv = [self.s.node_bin, str(self.s.runner_path), "dataset", "--out", str(out), "--count", str(int(p["count"])), "--seed", str(int(p["seed"])), "--spec", p["spec"]]
            return argv, int(p["count"])
        if kind == "train":
            for k in ("trainDatasetId", "validationDatasetId", "modelId"):
                if not SAFE_ID.match(p[k]):
                    raise ValueError(f"invalid {k}")
            argv = [py, "-m", "pipetwin_ml.cli", "train", "--train", str(self.s.datasets_dir / p["trainDatasetId"]), "--validation", str(self.s.datasets_dir / p["validationDatasetId"]), "--out", str(self.s.models_dir / p["modelId"])]
            return argv, 1
        if kind == "evaluate":
            for k in ("datasetId", "modelId"):
                if not SAFE_ID.match(p[k]):
                    raise ValueError(f"invalid {k}")
            argv = [py, "-m", "pipetwin_ml.cli", "evaluate", "--dataset", str(self.s.datasets_dir / p["datasetId"]), "--model", str(self.s.models_dir / p["modelId"] / "model.json")]
            return argv, 1
        raise ValueError(f"unknown job kind {kind}")

    def _update(self, job_id: str, **kw) -> None:
        sets = ", ".join(f"{k}=?" for k in kw) + ", updated_at=?"
        vals = tuple(dumps(v) if k == "result" else v for k, v in kw.items()) + (now(), job_id)
        self.db.execute(f"UPDATE jobs SET {sets} WHERE id=?", vals)

    def _run(self, job_id: str, argv: list[str], total: int) -> None:
        cwd = self.s.repo_root / "backend"
        try:
            self._update(job_id, status="running")
            proc = subprocess.Popen(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            with self._lock:
                self._procs[job_id] = proc
            done = 0
            last_line = ""
            assert proc.stdout is not None
            for line in proc.stdout:
                last_line = line.strip()[:500]
                done += 1
                self._update(job_id, progress=min(1.0, done / max(1, total)), message=last_line)
            rc = proc.wait()
            err = proc.stderr.read()[-2000:] if proc.stderr else ""
            current = self.get(job_id)
            if current and current["status"] == "cancelled":
                return
            if rc == 0:
                self._update(job_id, status="succeeded", progress=1.0, result={"lastLine": last_line})
            else:
                self._update(job_id, status="failed", message=(err or last_line)[-1000:])
        except Exception as e:  # noqa: BLE001 - job failures are reported, not raised into the server
            self._update(job_id, status="failed", message=str(e)[:1000])
        finally:
            with self._lock:
                self._procs.pop(job_id, None)


def list_models(models_dir: Path) -> list[dict]:
    out = []
    if not models_dir.exists():
        return out
    for d in sorted(models_dir.iterdir()):
        mf = d / "model.json"
        if not mf.exists():
            continue
        try:
            m = json.loads(mf.read_text())
        except json.JSONDecodeError:
            continue
        parity = m.get("parity") or {}
        out.append(
            {
                "id": d.name,
                "modelVersion": m.get("modelVersion"),
                "featureSchemaVersion": m.get("featureSchemaVersion"),
                "classes": m.get("classes"),
                "calibration": m.get("calibration", {}).get("status"),
                "parityMaxAbsDiff": parity.get("maxAbsDiff"),
                "validationStatus": "validated" if parity.get("maxAbsDiff") is not None and parity.get("maxAbsDiff") < 1e-9 else "parity_unchecked",
                "evaluationSummary": m.get("evaluationSummary"),
            }
        )
    return out
