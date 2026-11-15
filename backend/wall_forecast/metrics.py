"""Scores used for the neighbor-pipe check."""
from __future__ import annotations

import numpy as np


def pearson_r2(y_true, y_pred) -> float:
    """Square of the Pearson correlation. A constant series is undefined."""
    a = np.asarray(y_true, dtype=float)
    b = np.asarray(y_pred, dtype=float)
    if len(a) != len(b):
        raise ValueError(f"length mismatch: {len(a)} and {len(b)}")
    ok = np.isfinite(a) & np.isfinite(b)
    a, b = a[ok], b[ok]
    if len(a) < 3 or np.ptp(a) == 0 or np.ptp(b) == 0:
        return float("nan")
    return float(np.corrcoef(a, b)[0, 1] ** 2)


def mae(y_true, y_pred) -> float:
    return float(np.mean(np.abs(np.asarray(y_true, dtype=float) - np.asarray(y_pred, dtype=float))))


def top_recall(y_true, score, frac: float = 0.10) -> float:
    """Share of the thinnest segments that also sit in the lowest `score` band."""
    y_true = np.asarray(y_true, dtype=float)
    score = np.asarray(score, dtype=float)
    k = max(1, int(round(len(y_true) * frac)))
    worst = set(np.argsort(y_true)[:k])
    ours = set(np.argsort(score)[:k])
    return len(worst & ours) / k
