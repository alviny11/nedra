"""Prepare source data, train RF, calculate both cases and update the site's CSV."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))
from reproduction.publish import main

if __name__ == "__main__":
    main()
