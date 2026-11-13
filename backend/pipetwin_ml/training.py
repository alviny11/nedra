"""Transparent baseline: StandardScaler + multinomial LogisticRegression, trained on train only.

Hyper-parameter C and the decision threshold are chosen on the validation split; the test split is
never touched here. A small RandomForest is trained as a comparison candidate only (not exported).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, f1_score
from sklearn.preprocessing import StandardScaler

from .datasets import CLASSES, Dataset


@dataclass
class Trained:
    scaler: StandardScaler
    model: LogisticRegression
    C: float
    val_macro_f1: float
    rf_val_macro_f1: float
    calibration: dict
    min_top_score: float
    class_weight: str = "balanced"


def matrix(d: Dataset, scaler: StandardScaler | None = None) -> tuple[np.ndarray, np.ndarray]:
    X = d.frame[d.feature_names].to_numpy(dtype=float)
    y = d.frame["label"].map({c: i for i, c in enumerate(CLASSES)}).to_numpy()
    return X, y


def impute(X: np.ndarray, means: np.ndarray) -> np.ndarray:
    """Missing-feature policy shared with the browser: NaN -> training mean (z = 0 after scaling)."""
    Xi = X.copy()
    idx = np.where(~np.isfinite(Xi))
    Xi[idx] = means[idx[1]]
    return Xi


def fit_scaler(X: np.ndarray) -> StandardScaler:
    means = np.nanmean(X, axis=0)
    means = np.where(np.isfinite(means), means, 0.0)
    sc = StandardScaler().fit(impute(X, means))
    sc.scale_ = np.where(sc.scale_ > 1e-12, sc.scale_, 1.0)
    return sc


def expected_calibration_error(proba: np.ndarray, y: np.ndarray, bins: int = 10) -> float:
    conf = proba.max(axis=1)
    pred = proba.argmax(axis=1)
    ece = 0.0
    edges = np.linspace(0, 1, bins + 1)
    for a, b in zip(edges[:-1], edges[1:]):
        m = (conf > a) & (conf <= b)
        if m.any():
            ece += m.mean() * abs((pred[m] == y[m]).mean() - conf[m].mean())
    return float(ece)


def train(train_ds: Dataset, val_ds: Dataset, seed: int = 0) -> Trained:
    Xtr, ytr = matrix(train_ds)
    Xva, yva = matrix(val_ds)
    sc = fit_scaler(Xtr)
    Ztr = sc.transform(impute(Xtr, sc.mean_))
    Zva = sc.transform(impute(Xva, sc.mean_))
    labels = list(range(len(CLASSES)))
    best = None
    for cw in ("balanced", None):
        for C in (0.01, 0.1, 1.0, 10.0, 100.0):
            m = LogisticRegression(C=C, max_iter=5000, class_weight=cw, random_state=seed)
            m.fit(Ztr, ytr)
            f1 = f1_score(yva, m.predict(Zva), average="macro", labels=labels, zero_division=0)
            if best is None or f1 > best[0]:
                best = (f1, C, m, cw)
    assert best is not None
    f1, C, model, class_weight = best
    rf = RandomForestClassifier(n_estimators=200, max_depth=8, class_weight="balanced", random_state=seed, n_jobs=1)
    rf.fit(Ztr, ytr)
    rf_f1 = f1_score(yva, rf.predict(Zva), average="macro", labels=labels, zero_division=0)
    proba = model.predict_proba(Zva)
    onehot = np.eye(len(CLASSES))[yva]
    brier = float(np.mean([brier_score_loss(onehot[:, k], proba[:, k]) for k in range(len(CLASSES))]))
    ece = expected_calibration_error(proba, yva)
    # confident-decision threshold chosen on validation: smallest top-score with >= 90 % accuracy
    conf = proba.max(axis=1)
    pred = proba.argmax(axis=1)
    thr = 0.9
    for t in np.arange(0.4, 0.95, 0.05):
        sel = conf >= t
        if sel.sum() >= 20 and (pred[sel] == yva[sel]).mean() >= 0.9:
            thr = float(t)
            break
    calibration = {
        "status": "validated" if ece <= 0.05 else "not_validated",
        "method": "reliability (ECE, 10 bins) and multi-class Brier on the validation split",
        "brierValidation": brier,
        "eceValidation": ece,
        "note": "Probabilities are shown as calibrated only if ECE <= 0.05 on validation; otherwise the UI shows scores.",
    }
    return Trained(scaler=sc, model=model, C=C, val_macro_f1=float(f1), rf_val_macro_f1=float(rf_f1), calibration=calibration, min_top_score=thr, class_weight=str(class_weight))
