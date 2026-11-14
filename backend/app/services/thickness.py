"""CatBoost thickness for the fixed 2023-12-01 request.

The route calls PredictionService. It does not read reference answers or the training table.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_csv: dict[str, str] = {}


def _format_mm(value: float) -> str:
    if value != value or value in (float("inf"), float("-inf")) or value < 0:
        raise ValueError("CatBoost вернул нечисловую толщину")
    return format(value, ".16g")


def _compute(package: Path) -> str:
    path = str(package)
    if path not in sys.path:
        sys.path.insert(0, path)
    from run_inference import PredictionService

    payload = json.loads((package / "data" / "request_2023.json").read_text(encoding="utf-8"))
    result = PredictionService().predict(payload)
    if result.get("model_id") != "cb_history_d6_MAE":
        raise RuntimeError("unexpected model_id")
    lines = ["id,segment_id,thickness_pred"]
    for row in result["predictions"]:
        lines.append(f"{int(row['id'])},{int(row['segment_id'])},{_format_mm(float(row['prediction_mm']))}")
    if len(lines) != 148:
        raise RuntimeError("unexpected prediction count")
    return "\n".join(lines) + "\n"


def result_csv(repo_root: Path) -> str:
    package = (repo_root / "models" / "cb-history-d6").resolve()
    key = str(package)
    cached = _csv.get(key)
    if cached is not None:
        return cached
    if not (package / "model.cbm").is_file() or not (package / "data" / "request_2023.json").is_file():
        raise FileNotFoundError("cb-history-d6")
    body = _compute(package)
    _csv[key] = body
    return body
