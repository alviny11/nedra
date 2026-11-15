"""Shift one pig run onto the odometer of another.

Joint zeros are the measurement. Density correlation is only a check of how
far a straight interpolation misses, on a pair of runs that both already exist.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def _profile(x: np.ndarray, bins: np.ndarray, smooth: int) -> np.ndarray:
    hist = np.histogram(x, bins=bins)[0].astype(float)
    return np.convolve(hist, np.ones(smooth) / smooth, mode="same")


def estimate_shift(xa, xb, lo: float, hi: float, k0: float = 0.0, span: float = 15.0,
                   res: float = 0.25, smooth_m: float = 1.0) -> tuple[float, float]:
    """Shift k that best overlays the defect-density profile of A onto B on [lo, hi)."""
    xa = np.asarray(xa, dtype=float)
    xb = np.asarray(xb, dtype=float)
    bins = np.arange(lo - 3, hi + 3 + res, res)
    smooth = max(1, int(round(smooth_m / res)))
    hb = _profile(xb, bins, smooth)
    best_k, best_c = k0, -1.0
    if hb.std() == 0:
        return best_k, float("nan")
    for k in np.arange(k0 - span, k0 + span + res / 2, res):
        ha = _profile(xa + k, bins, smooth)
        if ha.std() == 0:
            continue
        corr = float(np.corrcoef(ha, hb)[0, 1])
        if corr > best_c:
            best_k, best_c = float(k), corr
    return best_k, best_c


def window_shifts(xa, xb, length_m: float, window: float = 100.0, k0: float = 0.0,
                  span: float = 15.0, min_points: int = 15) -> pd.DataFrame:
    """Local density shifts along the pipe. A confident window seeds the next one."""
    xa = np.asarray(xa, dtype=float)
    xb = np.asarray(xb, dtype=float)
    rows = []
    k_prev = k0
    for lo in np.arange(0, length_m, window):
        hi = lo + window
        if ((xb >= lo) & (xb < hi)).sum() < min_points:
            continue
        k, corr = estimate_shift(xa, xb, lo, hi, k_prev, span)
        rows.append({"lo": lo, "hi": hi, "mid": lo + window / 2, "shift": k, "corr": corr})
        if corr > 0.5:
            k_prev = k
    return pd.DataFrame(rows)


def fine_align(a: pd.DataFrame, b: pd.DataFrame, length_m: float, coarse: pd.DataFrame,
               window: float = 25.0) -> np.ndarray:
    """Distances of run A on the scale of run B: coarse windows, then 25 m refinement."""
    mid = coarse["mid"].to_numpy()
    shifts = coarse["shift"].to_numpy()

    def k_coarse(x: float) -> float:
        return float(shifts[np.abs(mid - x).argmin()])

    xa = a["x"].to_numpy()
    aligned = xa + np.array([k_coarse(x) for x in xa])
    xb = b["x"].to_numpy()
    for lo in np.arange(0, length_m, window):
        mask = (xa >= lo) & (xa < lo + window)
        if mask.sum() < 5:
            continue
        k0 = k_coarse(lo + window / 2)
        k, corr = estimate_shift(xa, xb, lo + k0, lo + window + k0, k0, span=1.5, res=0.05, smooth_m=0.3)
        if corr > 0.3:
            aligned[mask] = xa[mask] + k
    return aligned
