"""Wall-thickness forecast for 10 m pipe segments.

Case 1 starts from the previous in-line inspection, shifts it onto the
odometer of the run being forecast, and draws defect growth learned on
other pipes. Case 2 has no inspection of its own and follows elevation.
"""

from .forecast import run_case1, run_case2
from .metrics import mae, pearson_r2

__all__ = ["mae", "pearson_r2", "run_case1", "run_case2"]
