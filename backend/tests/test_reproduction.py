"""Integration checks for source-only training and compatibility with the live CSV."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

import pandas as pd
import pytest

from reproduction.pipeline import SPEC_PATH, compare_reference, reproduce
from reproduction.preparation import FILES

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def isolated_runs(tmp_path_factory):
    root = tmp_path_factory.mktemp("source-only")
    # Deliberately exclude backend_bundle, models, prepared tables and old CSV.
    (root / "backend").mkdir()
    for package in ("reproduction", "wall_forecast"):
        shutil.copytree(REPO / "backend" / package, root / "backend" / package,
                        ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy2(REPO / "reproduce.py", root / "reproduce.py")
    raw = root / "data" / "ili"
    raw.mkdir(parents=True)
    for name in FILES:
        shutil.copy2(REPO / "data" / "ili" / name, raw / name)
    outputs = []
    for name in ("first", "second"):
        output = root / name
        process = subprocess.run(
            [sys.executable, str(root / "reproduce.py"), "--output-dir", str(output)],
            cwd=root, capture_output=True, text=True, timeout=120,
        )
        assert process.returncode == 0, process.stdout + process.stderr
        outputs.append(output)
    return root, outputs


def test_training_from_only_five_raw_exports_is_repeatable(isolated_runs):
    root, outputs = isolated_runs
    assert not (root / "backend_bundle").exists()
    assert not (root / "data" / "forecasts").exists()
    for filename in ("result.csv", "training_between.csv", "predict_features.csv"):
        assert (outputs[0] / filename).read_bytes() == (outputs[1] / filename).read_bytes()
    report = json.loads((outputs[0] / "report.json").read_text())
    assert report["seed"] == 42
    assert report["training_rows"] == 614
    assert report["feature_count"] == 66
    assert set(report["source_sha256"]) == set(FILES)
    spec = json.loads(SPEC_PATH.read_text())
    assert hashlib.sha256((outputs[0] / "result.csv").read_bytes()).hexdigest() == spec["reconstructed_result_sha256"]
    training = pd.read_csv(outputs[0] / "training_between.csv")
    assert training.shape == (614, 75)
    assert not training.duplicated(["id", "segment_id", "end"]).any()
    # No 2023 label from the target section leaks into its own forecast.
    assert not ((training.id == 1250022871) & (training.end == "2023-12-01")).any()


def test_legacy_case1_tolerance_and_case2_exact_match(isolated_runs):
    _, outputs = isolated_runs
    spec = json.loads(SPEC_PATH.read_text())
    report = compare_reference(outputs[0] / "result.csv", REPO / "tests/fixtures/forecast/legacy-result.csv", spec)
    assert report["1"]["max_abs_difference_mm"] <= 0.004234
    assert report["2"]["exact_rows"] == 1475


def test_existing_outputs_and_changed_sources_are_protected(isolated_runs, tmp_path):
    root, outputs = isolated_runs
    raw = root / "data/ili"
    original = (outputs[0] / "result.csv").read_bytes()
    with pytest.raises(FileExistsError):
        reproduce(raw, outputs[0])
    assert (outputs[0] / "result.csv").read_bytes() == original
    broken = tmp_path / "raw"
    shutil.copytree(raw, broken)
    with (broken / FILES[0]).open("a") as stream:
        stream.write("\n")
    with pytest.raises(ValueError, match="Source checksum changed"):
        reproduce(broken, tmp_path / "bad-output")
    assert not (tmp_path / "bad-output").exists()


def test_publishing_updates_site_and_api_and_preserves_result_on_failure(isolated_runs):
    from reproduction.publish import publish
    from app.services.thickness import result_csv
    root, outputs = isolated_runs
    live = root / "data/forecasts/result.csv"
    live.parent.mkdir(parents=True, exist_ok=True)
    live.write_text("previous-result\n")
    run = publish(root)
    expected = (outputs[0] / "result.csv").read_bytes()
    assert live.read_bytes() == expected
    assert result_csv(root).encode() == expected
    assert (run / "case1.joblib").is_file()
    # A failed preparation must not destroy the downloadable result.
    raw = root / "data/ili" / FILES[0]
    original = raw.read_bytes()
    try:
        raw.write_bytes(original + b"\n")
        with pytest.raises(ValueError, match="Source checksum changed"):
            publish(root)
        assert live.read_bytes() == expected
    finally:
        raw.write_bytes(original)
