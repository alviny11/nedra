"""Regenerate data/forecasts/result.csv.

From the repository root:

    python forecast.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

from .forecast import config, run_case2
from .load import load_passport, load_profile, load_vtd

REPO = Path(__file__).resolve().parents[2]
BUNDLE = REPO / "backend_bundle"
RAW = REPO / "data" / "ili"
RESULT = REPO / "data" / "forecasts" / "result.csv"

CASE1_ID = 1250022871
CASE2_ID = 1250009583


def _ordered(frame: pd.DataFrame, pipe_id: int, n: int) -> pd.DataFrame:
    out = frame[["id", "segment_id", "thickness_pred"]].sort_values("segment_id").reset_index(drop=True)
    if len(out) != n or not out["id"].eq(pipe_id).all():
        raise ValueError(f"pipe {pipe_id} returned {len(out)} rows, expected {n}")
    if out["segment_id"].tolist() != list(range(n)):
        raise ValueError(f"pipe {pipe_id} is not in segment order")
    if not out["thickness_pred"].ge(0).all():
        raise ValueError(f"pipe {pipe_id} has a negative thickness")
    return out


def case1_frame() -> pd.DataFrame:
    """Random forest on the bundled snapshot. The case 2 joblib is not loaded."""
    sys.path.insert(0, str(BUNDLE))
    from predictor import Predictor

    engine = Predictor(BUNDLE)
    if set(engine.models) != {1}:
        raise RuntimeError(f"expected only the case 1 model, loaded {sorted(engine.models)}")
    rows = engine.predict_default(case=1)
    return _ordered(pd.DataFrame(rows), CASE1_ID, 525)


def case2_frame() -> pd.DataFrame:
    """Elevation line for 1250009583. No growth draw and no extra-trees model."""
    cfg = config()
    if int(cfg["case2"]["target_id"]) != CASE2_ID:
        raise ValueError("case 2 is not pipe 1250009583")
    pred = run_case2(cfg, load_passport(RAW), load_profile(RAW), load_vtd(RAW))["pred"]
    return _ordered(pred, CASE2_ID, 1475)


def render(case1: pd.DataFrame, case2: pd.DataFrame) -> str:
    head = case1.to_csv(index=False, float_format="%.6f", lineterminator="\n")
    tail = case2.to_csv(index=False, header=False, float_format="%.4f", lineterminator="\n")
    return head + tail


def main() -> None:
    text = render(case1_frame(), case2_frame())
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(text, encoding="utf-8")
    print(f"wrote {RESULT} ({text.count(chr(10)) - 1} rows)")


if __name__ == "__main__":
    main()
