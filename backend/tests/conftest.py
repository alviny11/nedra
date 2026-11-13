import shutil
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
sys.path.insert(0, str(BACKEND))

RUNNER = REPO / "tools" / "headless-runner" / "dist" / "pipetwin-runner.mjs"
FIXTURES = REPO / "tests" / "fixtures"


def runner_available() -> bool:
    return RUNNER.exists() and shutil.which("node") is not None


needs_runner = pytest.mark.skipif(not runner_available(), reason="headless runner bundle or node not available")


def run_runner(*args: str) -> str:
    res = subprocess.run(["node", str(RUNNER), *args], capture_output=True, text=True, timeout=600)
    if res.returncode != 0:
        raise RuntimeError(res.stderr[-2000:])
    return res.stdout
