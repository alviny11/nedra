"""Local single-user settings. Paths are resolved relative to the repository root."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    repo_root: Path
    data_dir: Path
    var_dir: Path
    db_path: Path
    runner_path: Path
    node_bin: str
    models_dir: Path
    datasets_dir: Path
    max_payload_bytes: int = 32 * 1024 * 1024
    max_batch_samples: int = 200_000
    max_dataset_runs: int = 2000


def get_settings() -> Settings:
    root = Path(os.environ.get("PIPETWIN_ROOT", REPO_ROOT)).resolve()
    var = Path(os.environ.get("PIPETWIN_VAR", root / "backend" / "var")).resolve()
    var.mkdir(parents=True, exist_ok=True)
    return Settings(
        repo_root=root,
        data_dir=root / "data",
        var_dir=var,
        db_path=Path(os.environ.get("PIPETWIN_DB", var / "pipetwin.sqlite")),
        runner_path=root / "tools" / "headless-runner" / "dist" / "pipetwin-runner.mjs",
        node_bin=os.environ.get("PIPETWIN_NODE", "node"),
        models_dir=root / "data" / "models",
        datasets_dir=root / "data" / "datasets",
    )
