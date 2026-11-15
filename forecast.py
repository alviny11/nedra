"""Regenerate data/forecasts/result.csv.

Case 1 is the bundled random forest. Case 2 is the elevation line for pipe
1250009583. From the repository root:

    python forecast.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

from wall_forecast.__main__ import main

if __name__ == "__main__":
    main()
