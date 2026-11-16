"""Rebuild the site's forecast from sources, then atomically activate its CSV."""
from pathlib import Path
import os
import tempfile

from .pipeline import REPO, reproduce


def publish(repo: Path = REPO) -> Path:
    repo = Path(repo).resolve()
    runs = repo / "output" / "reproduction-runs"
    runs.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="run-", dir=runs)) / "artifacts"
    # No live file is touched unless source checks, training and output validation pass.
    reproduce(repo / "data" / "ili", run)
    destination = repo / "data" / "forecasts" / "result.csv"
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".result-", suffix=".csv", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write((run / "result.csv").read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return run


def main() -> None:
    run = publish()
    print(f"Updated {REPO / 'data/forecasts/result.csv'} from five raw exports (seed 42).")
    print(f"Training data, new model and report: {run}")
    print("Refresh the dev site; rebuild the frontend for a production/preview site.")
