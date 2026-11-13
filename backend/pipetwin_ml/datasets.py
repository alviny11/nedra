"""Loading runner datasets and deriving labels from SEPARATE ground-truth files.

Feature rows (features.jsonl) contain only public information. Labels are computed here from
ground_truth.json + meta.json (public command times) with an explicit label policy; neither labels
nor truth fields are ever used as features.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

CLASSES = ["normal", "leak", "operating_change", "sensor_fault"]

LABEL_POLICY = (
    "leak: a leak has started and its open-area fraction at the window end is >= 0.05; "
    "sensor_fault: a sensor fault is active at the window end; "
    "operating_change: a public pump/valve command (t > 0) lies inside the feature window; "
    "normal: otherwise. Hidden inlet temperature / water-cut changes are labelled normal "
    "(policy: the D1 observer accounts for measured composition; composition_change is not a "
    "separate class in this version). Runs terminated by a model-domain stop are cut at the stop time."
)


def smoothstep(x: float) -> float:
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    return x * x * (3 - 2 * x)


def label_at(t: float, truth: dict, commands: list[dict], window_s: float) -> str:
    for e in truth["events"]:
        if e["kind"] == "leak" and t >= e["startTimeS"]:
            dur = e.get("openingDurationS") or 0.0
            frac = 1.0 if dur <= 0 else smoothstep((t - e["startTimeS"]) / dur)
            if frac >= 0.05:
                return "leak"
    for e in truth["events"]:
        if e["kind"] == "sensor_fault" and t >= e["startTimeS"] and (e.get("endTimeS") is None or t <= e["endTimeS"]):
            return "sensor_fault"
    for c in commands:
        if c["kind"] in ("pump_speed", "valve_opening") and c["t"] > 0 and t - window_s < c["t"] <= t:
            return "operating_change"
    return "normal"


@dataclass
class Dataset:
    frame: pd.DataFrame
    feature_names: list[str]
    manifest: dict
    runs: list[str]
    excluded_runs: list[str]


def load_dataset(path: Path) -> Dataset:
    manifest = json.loads((path / "manifest.json").read_text())
    names = [f["name"] for f in manifest["featureSchema"]["features"]]
    window = float(manifest["featureSchema"]["windowS"])
    rows = []
    runs, excluded = [], []
    for rd in sorted((path / "runs").iterdir()):
        gt_p, ft_p, meta_p = rd / "ground_truth.json", rd / "features.jsonl", rd / "meta.json"
        if not (gt_p.exists() and ft_p.exists() and meta_p.exists()):
            excluded.append(rd.name)  # incomplete run: never part of training/testing
            continue
        truth = json.loads(gt_p.read_text())
        meta = json.loads(meta_p.read_text())
        stop = truth["terminatedEarly"]["simTimeS"] if truth.get("terminatedEarly") else math.inf
        if meta.get("featureSchemaVersion") != manifest["featureSchema"]["featureSchemaVersion"]:
            raise ValueError(f"feature schema mismatch in {rd.name}")
        runs.append(rd.name)
        for line in ft_p.read_text().splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            t = float(r["simTimeS"])
            if t > stop:
                continue
            row = {"runId": r["runId"], "simTimeS": t, "label": label_at(t, truth, meta["commands"], window)}
            for n in names:
                v = r.get(n)
                row[n] = np.nan if v is None else float(v)
            rows.append(row)
    frame = pd.DataFrame(rows)
    return Dataset(frame=frame, feature_names=names, manifest=manifest, runs=runs, excluded_runs=excluded)


def check_disjoint(*datasets: Dataset) -> None:
    """Grouped split guarantee: no run id may appear in two splits."""
    seen: dict[str, int] = {}
    for i, d in enumerate(datasets):
        for r in d.runs:
            if r in seen and seen[r] != i:
                raise ValueError(f"run {r} appears in two splits")
            seen[r] = i
