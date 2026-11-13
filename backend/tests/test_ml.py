import json
from pathlib import Path

import numpy as np
import pytest

from pipetwin_ml.datasets import CLASSES, check_disjoint, label_at, load_dataset
from pipetwin_ml.training import fit_scaler, impute, train


def truth(events):
    return {"events": events}


def test_label_policy():
    leak = {"kind": "leak", "startTimeS": 300, "openingDurationS": 0}
    slow = {"kind": "leak", "startTimeS": 300, "openingDurationS": 200}
    fault = {"kind": "sensor_fault", "startTimeS": 300}
    inlet = {"kind": "inlet_change", "startTimeS": 300}
    cmds = [{"t": 0, "kind": "pump_speed"}, {"t": 400, "kind": "valve_opening"}]
    assert label_at(299, truth([leak]), [], 60) == "normal"
    assert label_at(301, truth([leak]), [], 60) == "leak"
    assert label_at(310, truth([slow]), [], 60) == "normal"  # open area fraction < 0.05
    assert label_at(400, truth([slow]), [], 60) == "leak"
    assert label_at(350, truth([fault]), [], 60) == "sensor_fault"
    assert label_at(500, truth([inlet]), [], 60) == "normal"  # policy: hidden composition change -> normal
    assert label_at(420, truth([]), cmds, 60) == "operating_change"
    assert label_at(470, truth([]), cmds, 60) == "normal"  # outside the window
    assert label_at(30, truth([]), cmds, 60) == "normal"  # t = 0 commands are set-up, not changes


def make_dataset(root: Path, name: str, seed0: int, n_runs: int) -> Path:
    d = root / name
    (d / "runs").mkdir(parents=True)
    names = [f"f{i}" for i in range(4)]
    (d / "manifest.json").write_text(json.dumps({"featureSchema": {"featureSchemaVersion": "t", "windowS": 60, "features": [{"name": n} for n in names]}}))
    rng = np.random.default_rng(seed0)
    for r in range(n_runs):
        rid = f"{name}-{seed0 + r}"
        rd = d / "runs" / rid
        rd.mkdir()
        kind = ["normal", "leak", "operating_change", "sensor_fault"][r % 4]
        events = []
        cmds = []
        if kind == "leak":
            events.append({"kind": "leak", "startTimeS": 300, "openingDurationS": 0})
        if kind == "sensor_fault":
            events.append({"kind": "sensor_fault", "startTimeS": 300})
        if kind == "operating_change":
            cmds.append({"t": 300, "kind": "pump_speed"})
        (rd / "ground_truth.json").write_text(json.dumps({"events": events, "terminatedEarly": None}))
        (rd / "meta.json").write_text(json.dumps({"featureSchemaVersion": "t", "commands": cmds}))
        lines = []
        for t in range(180, 600, 5):
            lab = label_at(t, {"events": events}, cmds, 60)
            mu = {"normal": 0, "leak": 3, "operating_change": -3, "sensor_fault": 6}[lab]
            vals = {n: float(rng.normal(mu if i == 0 else (mu / 2 if i == 1 else 0), 1)) for i, n in enumerate(names)}
            if t == 200:
                vals["f2"] = None
            lines.append(json.dumps({"runId": rid, "simTimeS": t, **vals}))
        (rd / "features.jsonl").write_text("\n".join(lines))
    return d


def test_load_train_and_split_guard(tmp_path):
    tr = load_dataset(make_dataset(tmp_path, "tr", 100, 12))
    va = load_dataset(make_dataset(tmp_path, "va", 200, 8))
    check_disjoint(tr, va)
    overlapping = type(tr)(tr.frame, tr.feature_names, tr.manifest, [tr.runs[0]], [])
    with pytest.raises(ValueError):
        check_disjoint(tr, overlapping)
    assert set(tr.frame["label"]) <= set(CLASSES)
    assert tr.frame["f2"].isna().sum() > 0  # missing values are kept as NaN, never 0
    m = train(tr, va)
    assert m.val_macro_f1 > 0.6
    # missing-feature policy: NaN -> training mean -> z = 0
    X = np.array([[np.nan, 0, 0, 0]], dtype=float)
    Z = m.scaler.transform(impute(X, m.scaler.mean_))
    assert abs(Z[0, 0]) < 1e-12


def test_scaler_handles_constant_and_missing_columns():
    X = np.array([[1.0, np.nan], [1.0, 2.0], [1.0, 4.0]])
    sc = fit_scaler(X)
    assert np.all(np.isfinite(sc.scale_)) and sc.scale_[0] == 1.0
