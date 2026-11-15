"""Serve the thickness forecast written by forecast.py.

Case 1 is the random forest for pipe 1250022871. Case 2 is the elevation
line for pipe 1250009583. The previous CatBoost packages are not read.
"""
from __future__ import annotations

from pathlib import Path


def result_csv(repo_root: Path) -> str:
    path = (repo_root / "data" / "forecasts" / "result.csv").resolve()
    if not path.is_file():
        raise FileNotFoundError("data/forecasts/result.csv")
    text = path.read_text(encoding="utf-8")
    if not text.startswith("id,segment_id,thickness_pred\n1250022871,"):
        raise RuntimeError("unexpected thickness forecast")
    if "1250009583," not in text:
        raise RuntimeError("case 2 pipe is missing from the thickness forecast")
    return text if text.endswith("\n") else text + "\n"
