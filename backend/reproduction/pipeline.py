"""Train from five source CSVs and export both cases without changing live assets."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import shutil
import tempfile

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.pipeline import make_pipeline

from wall_forecast.forecast import config, run_case2
from wall_forecast.load import load_passport, load_profile, load_vtd
from .preparation import FILES, Preparation

REPO = Path(__file__).resolve().parents[2]
SPEC_PATH = Path(__file__).with_name("spec.json")
KEYS = ["id", "segment_id"]
OUTPUT_COLUMNS = KEYS + ["thickness_pred"]
PACKAGES = ("numpy", "pandas", "scikit-learn", "scipy", "joblib", "threadpoolctl")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_sources(raw: Path, spec: dict) -> dict:
    hashes = {}
    for name in FILES:
        path = raw / name
        if not path.is_file():
            raise FileNotFoundError(path)
        hashes[name] = sha256(path)
        if hashes[name] != spec["source_sha256"][name]:
            raise ValueError(f"Source checksum changed: {name}; this recipe is for the supplied exports")
    return hashes


def fit_case1(training: pd.DataFrame, features: list[str], seed: int):
    if training.duplicated(KEYS + ["end"]).any() or not np.isfinite(training.rate_frac).all():
        raise ValueError("Training targets or keys are invalid")
    model = make_pipeline(
        SimpleImputer(strategy="median", keep_empty_features=True),
        RandomForestRegressor(
            n_estimators=300, max_features=0.8, min_samples_leaf=12,
            n_jobs=2, random_state=seed,
        ),
    )
    return model.fit(training[features], training.rate_frac)


def predict_case1(model, frame: pd.DataFrame, features: list[str]) -> pd.DataFrame:
    rate = model.predict(frame[features])
    values = np.minimum(
        np.clip(frame.base.to_numpy() - rate * frame.nominal.to_numpy() * frame.horizon.to_numpy(),
                0.1, frame.nominal.to_numpy()), frame.base.to_numpy(),
    )
    # Preserve the production output's rounding and no-growth cap, including
    # the floor when six-decimal rounding would cross the previous thickness.
    rounded = []
    for value, base in zip(values, frame.base):
        value = round(float(value), 6)
        rounded.append(math.floor(base * 1_000_000) / 1_000_000 if value > base else value)
    result = frame[KEYS].copy()
    result["thickness_pred"] = rounded
    return result


def render(case1: pd.DataFrame, case2: pd.DataFrame) -> str:
    for frame, asset_id, count in ((case1, 1250022871, 525), (case2, 1250009583, 1475)):
        if len(frame) != count or not frame.id.eq(asset_id).all():
            raise ValueError(f"Unexpected output grid for {asset_id}")
        if frame.segment_id.tolist() != list(range(count)):
            raise ValueError(f"Unexpected segment order for {asset_id}")
        if not np.isfinite(frame.thickness_pred).all() or not frame.thickness_pred.ge(0.1).all():
            raise ValueError(f"Invalid thickness for {asset_id}")
    return (
        case1[OUTPUT_COLUMNS].to_csv(index=False, float_format="%.6f", lineterminator="\n")
        + case2[OUTPUT_COLUMNS].to_csv(index=False, header=False, float_format="%.4f", lineterminator="\n")
    )


def reproduce(raw: Path, output: Path) -> dict:
    raw, output = Path(raw).resolve(), Path(output).resolve()
    # Never replace an existing folder, the application model, or its result.
    if output.exists():
        raise FileExistsError(f"Choose a new output directory: {output}")
    spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    source_hashes = check_sources(raw, spec)
    prep = Preparation(raw)
    training = prep.training()
    if len(training) != spec["training_rows"]:
        raise ValueError(f"Expected {spec['training_rows']} training rows, got {len(training)}")
    prediction = prep.build(1250022871, "2022-07-06", "2023-12-01")
    model = fit_case1(training, spec["features"], spec["seed"])
    case1 = predict_case1(model, prediction, spec["features"])
    # Reuse the production case 2 formula and its existing data-quality policy.
    case2_data = run_case2(config(), load_passport(raw), load_profile(raw), load_vtd(raw))
    case2 = case2_data["pred"][OUTPUT_COLUMNS].sort_values("segment_id").reset_index(drop=True)
    text = render(case1, case2)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix=".reproduction-", dir=output.parent))
    try:
        training.to_csv(temp / "training_between.csv", index=False, lineterminator="\n")
        prediction.to_csv(temp / "predict_features.csv", index=False, lineterminator="\n")
        prep.corrosion_audit().to_csv(temp / "corrosion_audit.csv", index=False, lineterminator="\n")
        case2_data["reference"].to_csv(temp / "case2_reference.csv", index=False, lineterminator="\n")
        (temp / "result.csv").write_text(text, encoding="utf-8")
        joblib.dump(model, temp / "case1.joblib")
        report = {
            "seed": spec["seed"], "training_rows": len(training), "feature_count": len(spec["features"]),
            "features": spec["features"], "source_sha256": source_hashes,
            "source_rows": prep.source_rows, "categories": prep.categories,
            "result_sha256": digest, "training_sha256": sha256(temp / "training_between.csv"),
            "case1_rows": len(case1), "case2_rows": len(case2),
            "case2_mean_loss": float(case2_data["mean_loss"]),
            "environment": {
                "python": platform.python_version(), "system": platform.system(),
                "machine": platform.machine(),
                "packages": {name: importlib.metadata.version(name) for name in PACKAGES},
            },
            "notes": [
                "repcorr is audited but is not a feature of the current RF.",
                "No pretrained model or prepared dataset was read to generate predictions.",
                "The case 2 production calculation and data-quality policy are unchanged.",
            ],
        }
        (temp / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if output.exists():
            raise FileExistsError(output)
        os.rename(temp, output)
    finally:
        if temp.exists():
            shutil.rmtree(temp)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, default=REPO / "data" / "ili")
    parser.add_argument("--output-dir", type=Path, default=REPO / "output" / "reproduction")
    args = parser.parse_args()
    try:
        report = reproduce(args.input_dir, args.output_dir)
    except (ValueError, FileNotFoundError, FileExistsError) as exc:
        parser.exit(1, f"Reproduction stopped: {exc}\n")
    print(f"Saved {report['case1_rows'] + report['case2_rows']} rows to {args.output_dir / 'result.csv'}")
    print(f"Training: {report['training_rows']} rows, {report['feature_count']} features, seed {report['seed']}")
    print(f"SHA256: {report['result_sha256']}")


if __name__ == "__main__":
    main()
