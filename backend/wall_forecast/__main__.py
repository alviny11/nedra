"""Write the combined thickness file for both pipes.

Run from the backend directory:

    python -m wall_forecast
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from .forecast import config, run_case1, run_case2
from .load import load_joints, load_passport, load_profile, load_vtd

REPO = Path(__file__).resolve().parents[2]
RAW = REPO / "data" / "ili"
RESULT = REPO / "data" / "forecasts" / "result.csv"
METRICS = REPO / "data" / "forecasts" / "metrics.json"

COLUMNS = ["id", "segment_id", "thickness_pred"]


def write_result(frame: pd.DataFrame, path: Path) -> None:
    out = frame[COLUMNS].sort_values(["id", "segment_id"]).reset_index(drop=True)
    if list(out.columns) != COLUMNS:
        raise ValueError(f"columns {list(out.columns)}")
    if out.duplicated(["id", "segment_id"]).any():
        raise ValueError("duplicate id, segment_id")
    if not out["thickness_pred"].ge(0).all():
        raise ValueError("negative thickness")
    path.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(path, index=False, float_format="%.4f", lineterminator="\n")


def main() -> None:
    cfg = config()
    passport = load_passport(RAW)
    vtd = load_vtd(RAW)
    profile = load_profile(RAW)
    joints = load_joints(RAW)
    case1 = run_case1(cfg, passport, vtd, joints)
    case2 = run_case2(cfg, passport, profile, vtd)
    both = pd.concat([
        case1["pred"][COLUMNS],
        case2["pred"][COLUMNS],
    ], ignore_index=True)
    write_result(both, RESULT)

    check = case1["validation"].set_index("method").loc["growth model + 5th percentile"]
    summary = {
        "rows": int(len(both)),
        "validation_section": int(case1["val_section"]),
        "pearson_r2": round(float(check["r2"]), 4),
        "mae_mm": round(float(check["mae_mm"]), 4),
        "shift_start_m": round(case1["drift_ends"][0], 2),
        "shift_end_m": round(case1["drift_ends"][1], 2),
        "pos_sigma_m": round(float(case1["pos_sigma"]), 2),
        "repair_prob": cfg["case1"]["repair_prob"],
        "matched_pairs": int(case1["model"].n_pairs),
        "case2_mean_loss": round(case2["mean_loss"], 3),
        "case2_p90_loss": round(case2["high_loss"], 3),
        "pipes": {},
    }
    written = pd.read_csv(RESULT)
    for pipe_id, group in written.groupby("id"):
        summary["pipes"][str(int(pipe_id))] = {
            "n": int(len(group)),
            "min": round(float(group["thickness_pred"].min()), 4),
            "mean": round(float(group["thickness_pred"].mean()), 4),
            "max": round(float(group["thickness_pred"].max()), 4),
        }
    METRICS.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    print(f"wrote {RESULT}")


if __name__ == "__main__":
    main()
