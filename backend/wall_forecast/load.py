"""Read the passport, the elevation profile, and the in-line inspection export."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

FILES = {
    "passport": "pot_south.csv",
    "profile": "altitudes_south.csv",
    "vtd": "vtd_south_train.csv",
}
SEG_LEN = 10.0

REQUIRED = {
    "profile": ["id", "total_distance", "z"],
    "vtd": ["id", "date", "Distance", "Distance_raw", "Wall Thickness", "Residual Wall Thickness",
            "Defect Depth in %", "Angle", "Feature Length", "Feature Width", "Defect Type",
            "Section Number", "Relative Distance", "Recommended Repair Method", "Repair Time (Years)",
            "is_beyond_pot", "Class", "Feature Description"],
}

_INTERNAL = {"Внутренний": True, "внутр.": True, "Внешний": False, "внешн.": False}


def check_columns(df: pd.DataFrame, key: str) -> pd.DataFrame:
    missing = [c for c in REQUIRED.get(key, []) if c not in df.columns]
    if missing:
        raise ValueError(f"{FILES[key]} is missing columns: {', '.join(missing)}")
    if df.empty:
        raise ValueError(f"{FILES[key]} is empty")
    return df


def n_segments(length_m: float) -> int:
    """Segment ids are 0 .. floor(L / 10). The last segment may be short."""
    return int(np.floor(length_m / SEG_LEN)) + 1


def seg_of(x, length_m: float) -> np.ndarray:
    """Segment index. Distances outside [0, L] are pinned to the end segments."""
    x = np.clip(np.asarray(x, dtype=float), 0.0, length_m)
    return np.clip(np.floor(x / SEG_LEN).astype(int), 0, n_segments(length_m) - 1)


def _col(df: pd.DataFrame, part: str) -> str:
    hits = [c for c in df.columns if part in c]
    if not hits:
        raise KeyError(f"passport has no column containing {part!r}")
    return hits[0]


def load_passport(raw: str | Path) -> pd.DataFrame:
    frame = pd.read_csv(Path(raw) / FILES["passport"])
    out = pd.DataFrame({
        "id": frame[_col(frame, "ID простого участка")].astype("int64"),
        "pipeline": frame[_col(frame, "Наименование основного участка")],
        "name": frame[_col(frame, "Наименование простого участка")],
        "length_m": frame[_col(frame, "L простого участка")] * 1000.0,
        "d_mm": frame["Общие данные_D, мм"],
        "wall_mm": frame[_col(frame, "Толщина  стенки по исполнительной")],
        "start_date": pd.to_datetime(frame["Общие данные_Дата ввода"], format="%d.%m.%Y"),
    })
    out["n_seg"] = out["length_m"].map(n_segments)
    return out.sort_values(["pipeline", "id"]).reset_index(drop=True)


def load_profile(raw: str | Path) -> pd.DataFrame:
    frame = check_columns(pd.read_csv(Path(raw) / FILES["profile"]), "profile")
    frame = frame.rename(columns={"total_distance": "dist_m", "z": "z_m"})
    grouped = frame.groupby(["id", "dist_m"], as_index=False)["z_m"].mean()
    return grouped.sort_values(["id", "dist_m"]).reset_index(drop=True)


def load_vtd(raw: str | Path) -> pd.DataFrame:
    """Metal-loss records. Seams, fittings and dents have no residual thickness and drop out.

    The 2018 export stores depth as a fraction. Later exports store percent.
    """
    frame = check_columns(pd.read_csv(Path(raw) / FILES["vtd"], low_memory=False), "vtd")
    frame = frame.rename(columns={
        "Distance": "x", "Distance_raw": "x_raw", "Wall Thickness": "wt",
        "Residual Wall Thickness": "rw", "Defect Depth in %": "dp", "Angle": "ang",
        "Feature Length": "fl", "Feature Width": "fw", "Class": "cls",
        "Feature Description": "descr", "Defect Type": "dtype", "is_beyond_pot": "beyond",
        "Section Number": "sec", "Relative Distance": "rel",
        "Recommended Repair Method": "rec_repair", "Repair Time (Years)": "repair_time",
    })
    frame["date"] = pd.to_datetime(frame["date"])
    frame = frame[frame["rw"].notna() & frame["dp"].notna()].copy()
    for _, group in frame.groupby("date"):
        if group["dp"].max() <= 1.5:
            frame.loc[group.index, "dp"] = group["dp"] * 100.0
    frame["internal"] = frame["dtype"].map(_INTERNAL).astype("boolean").fillna(True).astype(bool)
    frame["ang"] = frame["ang"].fillna(180.0)
    keep = ["id", "date", "x", "x_raw", "wt", "rw", "dp", "ang", "fl", "fw", "cls", "descr",
            "internal", "beyond", "sec", "rel", "rec_repair", "repair_time"]
    return (frame[keep]
            .sort_values(["id", "date", "x", "ang", "dp", "rw", "fl", "fw"], kind="mergesort")
            .reset_index(drop=True))


def load_joints(raw: str | Path) -> pd.DataFrame:
    """One row per pipe joint in a pig run.

    Each record carries the joint number and the distance from that joint.
    The joint zero is the record distance minus that offset. The 2022 and 2023
    joint numbers match, so the difference of zeros is the odometer shift.
    """
    frame = pd.read_csv(
        Path(raw) / FILES["vtd"], low_memory=False,
        usecols=["id", "date", "Distance_raw", "Section Number", "Relative Distance"],
    )
    frame = frame.dropna(subset=["Section Number", "Relative Distance", "Distance_raw"])
    frame["date"] = pd.to_datetime(frame["date"])
    frame["js"] = frame["Distance_raw"] - frame["Relative Distance"]
    joints = (frame.groupby(["date", "Section Number"])
              .agg(js=("js", "median"), n=("js", "size"), id=("id", "min"))
              .reset_index()
              .rename(columns={"Section Number": "sec"}))
    return joints.sort_values(["date", "js", "sec"]).reset_index(drop=True)


def run_dates(vtd: pd.DataFrame, pipe_id: int) -> list[pd.Timestamp]:
    return sorted(vtd.loc[vtd["id"] == pipe_id, "date"].unique())


def segment_state(defects: pd.DataFrame, length_m: float, wall_mm: float, x_col: str = "x") -> pd.DataFrame:
    """Per-segment state of one pig run.

    A segment with no defects keeps the tool wall thickness, or the passport wall.
    """
    n = n_segments(length_m)
    indexed = np.arange(n)
    assigned = defects.assign(seg=seg_of(defects[x_col], length_m))
    grouped = assigned.groupby("seg")
    wall = grouped["wt"].median().reindex(indexed)
    out = pd.DataFrame({
        "segment_id": indexed,
        "thk_min": grouped["rw"].min().reindex(indexed).to_numpy(),
        "n_def": grouped.size().reindex(indexed).fillna(0).astype(int).to_numpy(),
        "dp_max": grouped["dp"].max().reindex(indexed).fillna(0.0).to_numpy(),
        "rw_q05": grouped["rw"].quantile(0.05).reindex(indexed).to_numpy(),
        "wt": wall.interpolate(limit_direction="both").fillna(wall_mm).to_numpy(),
    })
    out["has_def"] = out["n_def"] > 0
    out["thk_min"] = out["thk_min"].fillna(out["wt"])
    out["rw_q05"] = out["rw_q05"].fillna(out["wt"])
    return out
