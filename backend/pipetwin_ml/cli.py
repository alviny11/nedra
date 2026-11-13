"""CLI of the PipeTwin ML pipeline.

  python -m pipetwin_ml.cli dataset  --out ../data/datasets/X --count N --seed S [--spec default]
  python -m pipetwin_ml.cli train    --train ../data/datasets/train --validation ../data/datasets/val --out ../data/models/m1
  python -m pipetwin_ml.cli evaluate --dataset ../data/datasets/test --model ../data/models/m1/model.json
  python -m pipetwin_ml.cli schemas  --out ../packages/contracts/schemas

Dataset generation delegates to the headless TS runner (same physics as the browser) through a
subprocess with an argument array. Training never sees the test split.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from sklearn.metrics import brier_score_loss, confusion_matrix, f1_score

from .datasets import CLASSES, LABEL_POLICY, check_disjoint, load_dataset
from .training import expected_calibration_error, impute, matrix, train

REPO = Path(__file__).resolve().parents[2]
RUNNER = REPO / "tools" / "headless-runner" / "dist" / "pipetwin-runner.mjs"


def _dump(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False, allow_nan=False))


def cmd_dataset(a: argparse.Namespace) -> int:
    argv = ["node", str(RUNNER), "dataset", "--out", str(Path(a.out).resolve()), "--count", str(int(a.count)), "--seed", str(int(a.seed)), "--spec", a.spec]
    return subprocess.call(argv)


def export_artifact(tr, names: list[str], meta: dict) -> dict:
    return {
        "schemaVersion": "1.0.0",
        "modelVersion": meta["modelVersion"],
        "featureSchemaVersion": meta["featureSchemaVersion"],
        "kind": "multinomial_logistic",
        "classes": CLASSES,
        "featureNames": names,
        "scalerMean": [float(x) for x in tr.scaler.mean_],
        "scalerScale": [float(x) for x in tr.scaler.scale_],
        "coefficients": [[float(v) for v in row] for row in tr.model.coef_],
        "intercepts": [float(x) for x in tr.model.intercept_],
        "classMapping": {c: c for c in CLASSES},
        "missingFeaturePolicy": "impute_scaler_mean",
        "decisionThresholds": {"minTopScore": tr.min_top_score},
        "calibration": {k: v for k, v in tr.calibration.items() if k in ("status", "method", "brierValidation", "note")},
        "trainingMetadata": meta["training"],
        "evaluationSummary": meta["evaluation"],
    }


def cmd_train(a: argparse.Namespace) -> int:
    tr_ds = load_dataset(Path(a.train))
    va_ds = load_dataset(Path(a.validation))
    check_disjoint(tr_ds, va_ds)
    if tr_ds.feature_names != va_ds.feature_names:
        raise SystemExit("MODEL_SCHEMA_MISMATCH: feature names differ between splits")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    tr = train(tr_ds, va_ds, seed=0)
    counts = lambda d: {c: int((d.frame["label"] == c).sum()) for c in CLASSES}  # noqa: E731
    meta = {
        "modelVersion": out.name if out.name.startswith("logreg") else f"logreg-{out.name}",
        "featureSchemaVersion": tr_ds.manifest["featureSchema"]["featureSchemaVersion"],
        "training": {
            "trainDataset": str(Path(a.train).name),
            "validationDataset": str(Path(a.validation).name),
            "trainRuns": len(tr_ds.runs),
            "validationRuns": len(va_ds.runs),
            "excludedIncompleteRuns": tr_ds.excluded_runs + va_ds.excluded_runs,
            "trainWindows": int(len(tr_ds.frame)),
            "validationWindows": int(len(va_ds.frame)),
            "classCountsTrain": counts(tr_ds),
            "classCountsValidation": counts(va_ds),
            "C": tr.C,
            "classWeight": tr.class_weight,
            "split": "grouped by run: separate datasets generated with disjoint seed ranges; test split untouched during training/selection",
            "labelPolicy": LABEL_POLICY,
            "comparisonCandidate": {"model": "RandomForest(200, depth 8)", "validationMacroF1": tr.rf_val_macro_f1, "exported": False},
        },
        "evaluation": {"validationMacroF1": tr.val_macro_f1, "eceValidation": tr.calibration["eceValidation"], "note": "validation only; see evaluate for the held-out test split"},
    }
    art = export_artifact(tr, tr_ds.feature_names, meta)
    # golden matrix for browser parity (validation rows, includes missing values)
    Xva, _ = matrix(va_ds)
    rng = np.random.default_rng(0)
    idx = rng.choice(len(Xva), size=min(64, len(Xva)), replace=False)
    Xg = Xva[idx].copy()
    Xg[0, 0] = np.nan
    proba = tr.model.predict_proba(tr.scaler.transform(impute(Xg, tr.scaler.mean_)))
    golden = {"X": [[None if not np.isfinite(v) else float(v) for v in row] for row in Xg], "proba": proba.tolist()}
    _dump(out / "golden.json", golden)
    _dump(out / "model.json", art)
    # parity with the TS implementation (same code the browser runs)
    parity = None
    if RUNNER.exists():
        res = subprocess.run(["node", str(RUNNER), "parity", "--model", str(out / "model.json"), "--golden", str(out / "golden.json")], capture_output=True, text=True)
        try:
            parity = json.loads(res.stdout.strip().splitlines()[-1])
        except (json.JSONDecodeError, IndexError):
            parity = {"ok": False, "error": res.stderr[-500:]}
    if parity and "maxAbsDiff" in parity:
        art["parity"] = {"goldenFile": "golden.json", "maxAbsDiff": float(parity["maxAbsDiff"])}
        _dump(out / "model.json", art)
    _dump(out / "manifest.json", {**meta, "parity": parity, "artifact": "model.json", "golden": "golden.json"})
    print(json.dumps({"model": str(out / "model.json"), "C": tr.C, "valMacroF1": round(tr.val_macro_f1, 4), "rfValMacroF1": round(tr.rf_val_macro_f1, 4), "ece": round(tr.calibration["eceValidation"], 4), "parity": parity}))
    return 0


def cmd_evaluate(a: argparse.Namespace) -> int:
    art = json.loads(Path(a.model).read_text())
    ds = load_dataset(Path(a.dataset))
    if ds.feature_names != art["featureNames"]:
        raise SystemExit("MODEL_SCHEMA_MISMATCH")
    # grouped-split guarantee: the evaluated runs must not appear in the model's training/validation sets
    tm = art.get("trainingMetadata", {})
    used = [REPO / "data" / "datasets" / tm[k] for k in ("trainDataset", "validationDataset") if tm.get(k)]
    used = [u for u in used if (u / "runs").exists()]
    check_disjoint(ds, *[load_dataset(u) for u in used])
    X, y = matrix(ds)
    mean = np.array(art["scalerMean"])
    Z = (impute(X, mean) - mean) / np.array(art["scalerScale"])
    logits = Z @ np.array(art["coefficients"]).T + np.array(art["intercepts"])
    logits -= logits.max(axis=1, keepdims=True)
    p = np.exp(logits)
    p /= p.sum(axis=1, keepdims=True)
    pred = p.argmax(axis=1)
    labels = list(range(len(CLASSES)))
    f1 = f1_score(y, pred, average="macro", labels=labels, zero_division=0)
    cm = confusion_matrix(y, pred, labels=labels)
    # bootstrap over runs (not neighbouring windows)
    rng = np.random.default_rng(1)
    runs = ds.frame["runId"].to_numpy()
    uniq = np.unique(runs)
    by = {r: np.where(runs == r)[0] for r in uniq}
    boots = []
    for _ in range(300):
        sel = np.concatenate([by[r] for r in rng.choice(uniq, size=len(uniq), replace=True)])
        boots.append(f1_score(y[sel], pred[sel], average="macro", labels=labels, zero_division=0))
    res = {
        "dataset": Path(a.dataset).name,
        "runs": len(ds.runs),
        "windows": int(len(y)),
        "macroF1": float(f1),
        "macroF1CI95": [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))],
        "classes": CLASSES,
        "confusionMatrix": cm.tolist(),
        "perClassRecall": {c: (float(cm[i, i] / cm[i].sum()) if cm[i].sum() else None) for i, c in enumerate(CLASSES)},
        "disjointFromTraining": [u.name for u in used],
        "ece": expected_calibration_error(p, y),
        "brier": float(np.mean([brier_score_loss((y == k).astype(int), p[:, k]) for k in labels])),
        "note": "Window-level classification on a held-out split of synthetic runs; windows of one run are not independent. ECE/Brier are measured on this split (the artefact's 'validated' status refers to the validation split only).",
    }
    out = Path(a.model).parent / f"evaluation_{Path(a.dataset).name}.json"
    _dump(out, res)
    print(json.dumps({k: res[k] for k in ("dataset", "runs", "windows", "macroF1", "macroF1CI95", "ece", "brier")}))
    return 0


def cmd_schemas(a: argparse.Namespace) -> int:
    sys.path.insert(0, str(REPO / "backend"))
    from app.main import create_app  # noqa: PLC0415
    from app.schemas.domain import EXPORTED_SCHEMAS  # noqa: PLC0415

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, model in EXPORTED_SCHEMAS.items():
        _dump(out / f"{name}.schema.json", model.model_json_schema())
    _dump(out / "openapi.json", create_app().openapi())
    print(f"wrote {len(EXPORTED_SCHEMAS)} schemas + openapi.json to {out}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(prog="pipetwin_ml")
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("dataset")
    d.add_argument("--out", required=True)
    d.add_argument("--count", type=int, default=10)
    d.add_argument("--seed", type=int, default=1000)
    d.add_argument("--spec", default="default", choices=["default", "ood", "heldout", "lowrate"])
    t = sub.add_parser("train")
    t.add_argument("--train", required=True)
    t.add_argument("--validation", required=True)
    t.add_argument("--out", required=True)
    e = sub.add_parser("evaluate")
    e.add_argument("--dataset", required=True)
    e.add_argument("--model", required=True)
    s = sub.add_parser("schemas")
    s.add_argument("--out", default=str(REPO / "packages" / "contracts" / "schemas"))
    a = p.parse_args()
    return {"dataset": cmd_dataset, "train": cmd_train, "evaluate": cmd_evaluate, "schemas": cmd_schemas}[a.cmd](a)


if __name__ == "__main__":
    raise SystemExit(main())
