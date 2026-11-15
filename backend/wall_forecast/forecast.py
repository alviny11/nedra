"""Case 1 grows the previous inspection. Case 2 follows elevation."""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import align, growth, load
from .metrics import mae, pearson_r2, top_recall

# The 2022 report's instruction to cut the joint out and weld in a pup.
CUT_OUT = "Врезка катушки"

# Pipe 1250022871, forecast date 2023-12-01. The pipe has inspections in 2018 and
# 2022 and none of its own on the forecast date. Nominal wall is 8.0 mm.
CASE1 = {
    "target_id": 1250022871,
    "start_run": "2022-07-06",
    "target_run": "2023-12-01",
    "n_sim": 1000,
    "match_tol_m": 0.08,
    "blend_w": 0.5,
    "pos_sigma_m": 1.0,
    "repair_prob": 0.8,
    "val_blocks": 5,
    "val_gap_m": 10.0,
    "val_pos_sigma_m": 0.25,
}

# Pipe 1250009583, forecast date 2022-07-01. No inspection of its own.
# Passport wall is 4.5 mm. The prediction stays at or below that wall.
CASE2 = {
    "target_id": 1250009583,
    "target_date": "2022-07-01",
    "smooth_window_m": 1000.0,
    "spread": 0.5,
}

SEED = 42


def config() -> dict:
    return {"seed": SEED, "case1": dict(CASE1), "case2": dict(CASE2)}


def _offsets(vtd: pd.DataFrame, date) -> dict:
    """Chainage of each section start on the pig run `date` only.

    Later exports must not move the origin.
    """
    run = vtd[vtd["date"] == pd.Timestamp(date)]
    return (run["x_raw"] - run["x"]).groupby(run["id"]).median().round(1).to_dict()


def joint_shifts(joints: pd.DataFrame, date_a, date_b, ids) -> pd.DataFrame:
    """Odometer shift of run B relative to run A, from joints present in both."""
    a = joints[(joints["date"] == pd.Timestamp(date_a)) & joints["id"].isin(ids)]
    b = joints[(joints["date"] == pd.Timestamp(date_b)) & joints["id"].isin(ids)]
    matched = a.merge(b, on="sec", suffixes=("_a", "_b"))
    matched["shift"] = matched["js_b"] - matched["js_a"]
    return matched.sort_values("js_a").reset_index(drop=True)


def _shift_fn(shifts: pd.DataFrame):
    """Shift at a raw distance of run A. Linear between the shared joint zeros."""
    xa = shifts["js_a"].to_numpy(dtype=float)
    shift = shifts["shift"].to_numpy(dtype=float)
    return lambda x_raw: np.interp(np.asarray(x_raw, dtype=float), xa, shift)


def _anchor(vtd, shifts, pipe_id, length, d_mm, origin, date_a, date_b, tol, exclude=None) -> dict:
    """Defects of run A on the scale of run B, and the pairs they form with B.

    `exclude` is (lo, hi) in metres of run B. Joints that start inside it are
    left out of the shift, which is then interpolated from the joints outside.
    That keeps a hidden block from telling us where it sits.
    """
    a = vtd[(vtd["id"] == pipe_id) & (vtd["date"] == date_a)].copy()
    b = vtd[(vtd["id"] == pipe_id) & (vtd["date"] == date_b)].copy()
    if exclude is not None:
        local_b = shifts["js_b"] - origin
        shifts = shifts[~((local_b >= exclude[0]) & (local_b < exclude[1]))]
    a["x2"] = a["x_raw"].to_numpy() + _shift_fn(shifts)(a["x_raw"]) - origin
    pairs, new, confirmed = growth.match_defects(a, b, d_mm, tol)
    return {"a": a, "b": b, "pairs": pairs, "new": new, "confirmed": confirmed, "L": length}


def _xcorr_pair(vtd, pipe_id, length, date_a, date_b) -> dict:
    """Density alignment. Used only where joint numbers do not match (the 2018 run).

    It looks at run B, so it is a diagnostic of interpolation error, not a score
    of the forecast and not a shift taken from a future run of the target pipe.
    """
    a = vtd[(vtd["id"] == pipe_id) & (vtd["date"] == date_a)].copy()
    b = vtd[(vtd["id"] == pipe_id) & (vtd["date"] == date_b)].copy()
    k0, _ = align.estimate_shift(a["x"], b["x"], 0, min(length, 150.0), 0.0, span=25.0, res=0.5)
    coarse = align.window_shifts(a["x"], b["x"], length, window=min(250.0, length), k0=k0, span=6.0, min_points=10)
    if coarse.empty:
        coarse = pd.DataFrame([{"lo": 0.0, "hi": length, "mid": length / 2, "shift": k0, "corr": np.nan}])
    a["x2"] = align.fine_align(a, b, length, coarse)
    return {"a": a, "b": b, "coarse": coarse, "L": length}


def drift_linearity(vtd, pipe_id, length, date_a, date_b) -> pd.DataFrame:
    """How far the local shift bends away from the straight line between the ends.

    Measured on a pair that is known along the whole pipe. The scatter is the
    position error of a linear interpolation where the later run is missing.
    """
    coarse = _xcorr_pair(vtd, pipe_id, length, date_a, date_b)["coarse"]
    coarse = coarse[coarse["corr"] >= 0.3].reset_index(drop=True)
    line = np.interp(
        coarse["mid"],
        [coarse["mid"].iloc[0], coarse["mid"].iloc[-1]],
        [coarse["shift"].iloc[0], coarse["shift"].iloc[-1]],
    )
    return coarse.assign(linear=line, residual=coarse["shift"] - line)[
        ["lo", "hi", "shift", "corr", "linear", "residual"]
    ]


def _bump(x, length: float) -> np.ndarray:
    """Position error is smaller at the ends, where a joint was measured, and larger mid-pipe."""
    return 0.25 + 0.75 * np.sin(np.pi * np.clip(np.asarray(x, dtype=float), 0, length) / length)


def _fit(parts) -> growth.GrowthModel:
    return growth.GrowthModel.fit(
        pd.concat([p["pairs"] for p in parts], ignore_index=True),
        np.concatenate([p["new"]["dp"].to_numpy() for p in parts]),
        np.concatenate([p["a"]["dp"].to_numpy() for p in parts]),
        np.concatenate([p["confirmed"] for p in parts]),
    )


def _outside(anchor: dict, lo: float, hi: float) -> dict:
    """Neighbor-pipe rows outside [lo, hi). The hidden block does not train the growth law."""
    def keep(x):
        return ~((x >= lo) & (x < hi))

    mask_a = keep(anchor["a"]["x2"]).to_numpy()
    return {
        "a": anchor["a"][mask_a],
        "confirmed": anchor["confirmed"][mask_a],
        "pairs": anchor["pairs"][keep(anchor["pairs"]["x_b"]).to_numpy()],
        "new": anchor["new"][keep(anchor["new"]["x"]).to_numpy()],
    }


def _z(values: np.ndarray) -> np.ndarray:
    scale = values.std()
    return (values - values.mean()) / (scale if scale > 0 else 1.0)


def blend(model: np.ndarray, q05: np.ndarray, weight: float) -> np.ndarray:
    """Average the growth draw and the 5th percentile in standardized units, on the mm scale of the draw."""
    return model.mean() + model.std() * ((1 - weight) * _z(model) + weight * _z(q05))


def run_case1(cfg: dict, passport: pd.DataFrame, vtd: pd.DataFrame, joints: pd.DataFrame | None = None) -> dict:
    c = cfg["case1"]
    target_id = int(c["target_id"])
    start = pd.Timestamp(c["start_run"])
    target = pd.Timestamp(c["target_run"])
    seed, tol = cfg["seed"], c["match_tol_m"]
    by_id = passport.set_index("id")
    pipe_ids = passport.loc[passport["pipeline"] == by_id.loc[target_id, "pipeline"], "id"].tolist()
    origin = _offsets(vtd, start)
    length = by_id.loc[target_id, "length_m"]
    wall = by_id.loc[target_id, "wall_mm"]
    diameter = by_id.loc[target_id, "d_mm"]
    shifts = joint_shifts(joints, start, target, pipe_ids)
    if len(shifts) < 2:
        raise RuntimeError("the two pig runs share no joints, so the odometer shift is undefined")

    anchor_ids = [p for p in pipe_ids if p != target_id and {start, target} <= set(load.run_dates(vtd, p))]
    anchors = {
        p: _anchor(vtd, shifts, p, by_id.loc[p, "length_m"], diameter, origin[p], start, target, tol)
        for p in anchor_ids
    }
    if not anchors:
        raise RuntimeError("no neighbor has both pig runs, so the growth law has nothing to learn from")

    # Five blocks on the longest neighbor. The later run inside a block, plus a
    # gap on either side, is hidden from the shift and from the growth law.
    val_id = max(anchors, key=lambda p: load.n_segments(anchors[p]["L"]))
    val_length = anchors[val_id]["L"]
    val_wall = by_id.loc[val_id, "wall_mm"]
    fact = load.segment_state(anchors[val_id]["b"], val_length, val_wall)
    n = len(fact)
    gap = c["val_gap_m"]
    columns = ("raw", "pers", "q05", "mc", "p10", "p90", "blend")
    held = {key: np.full(n, np.nan) for key in columns}
    block_of = np.zeros(n, dtype=int)
    for block_i, block in enumerate(np.array_split(np.arange(n), c["val_blocks"])):
        lo = block[0] * load.SEG_LEN
        hi = (block[-1] + 1) * load.SEG_LEN
        hidden = (lo - gap, hi + gap)
        anchored = _anchor(
            vtd, shifts, val_id, val_length, diameter, origin[val_id], start, target, tol, exclude=hidden,
        )
        train = [_outside(anchored, hidden[0], hidden[1])]
        train += [anchors[q] for q in anchors if q != val_id]
        model = _fit([part for part in train if len(part["pairs"])])
        summary = growth.summarize(model.simulate(
            anchored["a"]["x2"], anchored["a"]["dp"], anchored["a"]["wt"], val_length, val_wall,
            n_sim=c["n_sim"], seed=seed, pos_sigma=c["val_pos_sigma_m"], pos_bump=np.ones(len(anchored["a"])),
        ))
        aligned = load.segment_state(anchored["a"], val_length, val_wall, x_col="x2")
        held["raw"][block] = load.segment_state(anchored["a"], val_length, val_wall)["thk_min"].to_numpy()[block]
        held["pers"][block] = aligned["thk_min"].to_numpy()[block]
        held["q05"][block] = aligned["rw_q05"].to_numpy()[block]
        held["mc"][block] = summary["thickness_pred"].to_numpy()[block]
        held["p10"][block] = summary["p10"].to_numpy()[block]
        held["p90"][block] = summary["p90"].to_numpy()[block]
        # The mixture is standardized on this fold's forecast for the whole neighbor.
        # The hidden block's measured thickness is not in those statistics.
        mixed = blend(summary["thickness_pred"].to_numpy(), aligned["rw_q05"].to_numpy(), c["blend_w"])
        held["blend"][block] = mixed[block]
        block_of[block] = block_i

    y = fact["thk_min"].to_numpy()
    horizon = round((target - start).days / 365.25, 2)
    methods = (
        ("previous ILI, unaligned", "raw", "raw"),
        ("previous ILI, distances aligned", "pers", "pers"),
        ("5th percentile of residual thickness", "q05", "q05"),
        ("defect growth model", "mc", "p10"),
        ("growth model + 5th percentile", "blend", "blend"),
    )
    validation = pd.DataFrame([
        {
            "method": name,
            "horizon_years": horizon,
            "n_segments": n,
            "r2": pearson_r2(y, held[key]),
            "mae_mm": mae(y, held[key]),
            "top10_recall": top_recall(y, held[rank_key]),
        }
        for name, key, rank_key in methods
    ])
    by_block = pd.DataFrame([
        {
            "block": block_i,
            "segments": f"{np.where(block_of == block_i)[0][0]}–{np.where(block_of == block_i)[0][-1]}",
            **{key: pearson_r2(y[block_of == block_i], held[key][block_of == block_i])
               for key in ("pers", "q05", "mc", "blend")},
        }
        for block_i in range(c["val_blocks"])
    ])
    correction = held["blend"] - held["mc"]
    held["p10"] = np.minimum(held["p10"], held["p10"] + correction)
    held["p90"] = np.maximum(held["p90"], held["p90"] + correction)
    coverage = float(np.mean((y >= held["p10"]) & (y <= held["p90"])))
    points = pd.DataFrame({
        "id": val_id,
        "segment_id": np.arange(n),
        "block": block_of,
        "fact": y,
        **{f"pred_{key}": held[key] for key in ("raw", "pers", "q05", "mc", "blend", "p10", "p90")},
    })

    earlier = [d for d in load.run_dates(vtd, target_id) if d < start]
    linearity = drift_linearity(vtd, target_id, length, earlier[-1], start) if earlier else pd.DataFrame()
    if len(linearity) >= 4:
        pos_sigma = float(np.sqrt(np.mean(linearity["residual"] ** 2)))
    else:
        pos_sigma = c["pos_sigma_m"]
    pos_sigma = max(pos_sigma, c["pos_sigma_m"])

    # Defects of the start run on the whole line. After the shift, some defects
    # that the tool recorded on a neighbor fall inside the target section.
    # The shift itself comes from joints of the two runs, not from a later run
    # of the target pipe.
    source = vtd[(vtd["id"].isin(pipe_ids)) & (vtd["date"] == start)].copy()
    source["xt"] = source["x_raw"].to_numpy() + _shift_fn(shifts)(source["x_raw"]) - origin[target_id]
    source = source[(source["xt"] >= 0) & (source["xt"] < length)]
    cut_joints = sorted(source.loc[source["rec_repair"] == CUT_OUT, "sec"].unique())
    on_cut = source["sec"].isin(cut_joints).to_numpy()
    model = _fit(list(anchors.values()))
    draws = model.simulate(
        source["xt"], source["dp"], source["wt"], length, wall,
        n_sim=c["n_sim"], seed=seed, pos_sigma=pos_sigma, pos_bump=_bump(source["xt"], length),
        repair_mask=on_cut, repair_prob=c["repair_prob"], repair_groups=source["sec"].to_numpy(),
    )
    pred = growth.summarize(draws)
    previous = load.segment_state(source, length, wall, x_col="xt")
    pred["model_only"] = pred["thickness_pred"]
    pred["thickness_pred"] = blend(pred["model_only"].to_numpy(), previous["rw_q05"].to_numpy(), c["blend_w"])
    # On a joint that was probably replaced, the 5th percentile describes a pipe
    # that is no longer there. Keep the growth draw on that joint and its neighbors.
    if on_cut.any():
        cut_seg = np.unique(load.seg_of(source.loc[on_cut, "xt"], length))
        touched = np.unique(np.concatenate([cut_seg - 1, cut_seg, cut_seg + 1]))
        touched = touched[(touched >= 0) & (touched < len(pred))]
    else:
        cut_seg = np.array([], dtype=int)
        touched = cut_seg
    pred.loc[touched, "thickness_pred"] = pred.loc[touched, "model_only"]
    pred["thickness_pred"] = pred["thickness_pred"].clip(lower=0.0, upper=wall)
    delta = pred["thickness_pred"] - pred["model_only"]
    pred["p10"] = np.minimum(pred["p10"], pred["p10"] + delta).clip(lower=0.0, upper=wall)
    pred["p90"] = np.maximum(pred["p90"], pred["p90"] + delta).clip(lower=0.0, upper=wall)
    pred.insert(0, "id", target_id)
    pred["wall_mm"] = previous["wt"].to_numpy()
    pred["repair_flag"] = np.isin(np.arange(len(pred)), cut_seg)
    ends = _shift_fn(shifts)([origin[target_id], origin[target_id] + length])
    return {
        "pred": pred,
        "validation": validation,
        "by_block": by_block,
        "val_points": points,
        "coverage": coverage,
        "linearity": linearity,
        "model": model,
        "pos_sigma": pos_sigma,
        "val_section": val_id,
        "drift_ends": (float(ends[0]), float(ends[1])),
        "repair_joints": cut_joints,
    }


def _elevation(profile: pd.DataFrame, pipe_id: int, length_m: float) -> pd.DataFrame:
    """Segment elevation. Lows matter: water collects there."""
    n = load.n_segments(length_m)
    x = (np.arange(n) + 0.5) * load.SEG_LEN
    rows = profile[profile["id"] == pipe_id]
    out = pd.DataFrame({"segment_id": np.arange(n), "p_z": np.zeros(n)})
    if len(rows) < 2:
        return out
    z_raw = pd.Series(rows["z_m"].to_numpy()).rolling(3, center=True, min_periods=1).median().to_numpy()
    out["p_z"] = np.interp(x, rows["dist_m"].to_numpy(), z_raw)
    return out


def elevation_score(profile_segments: pd.DataFrame, window_m: float = 1000.0) -> np.ndarray:
    """Higher where the elevation, smoothed over about 1 km, is lower. Standardized on the pipe."""
    window = max(3, int(window_m / load.SEG_LEN) | 1)
    window = min(window, max(3, (len(profile_segments) // 3) | 1))
    smooth = profile_segments["p_z"].rolling(window, center=True, min_periods=1).mean()
    scale = smooth.std()
    return (-(smooth - smooth.mean()) / (scale if scale > 0 else 1.0)).to_numpy()


def reference_losses(passport, vtd, profile, exclude_ids, window_m: float = 1000.0, before=None):
    """First inspection of every other pipe strictly before `before`.

    Returns the per-pipe table, the mean relative loss, and the 90th percentile of loss.
    The elevation line is not fitted, so the r² on each pipe is only a check.
    """
    runs = vtd if before is None else vtd[vtd["date"] < pd.Timestamp(before)]
    rows, losses = [], []
    for row in passport.itertuples():
        if row.id in exclude_ids:
            continue
        dates = sorted(runs.loc[runs["id"] == row.id, "date"].unique())
        if not dates:
            continue
        defects = runs[(runs["id"] == row.id) & (runs["date"] == dates[0])]
        state = load.segment_state(defects, row.length_m, float(defects["wt"].median()))
        losses.append(((state["wt"] - state["thk_min"]) / state["wt"]).to_numpy())
        if row.n_seg < 30:
            continue
        segments = _elevation(profile, row.id, row.length_m)
        if segments["p_z"].std() == 0:
            continue
        score = elevation_score(segments, window_m)
        corr = float(np.corrcoef(score, -state["thk_min"])[0, 1]) if state["thk_min"].std() > 0 else np.nan
        rows.append({
            "pipeline": row.pipeline,
            "id": row.id,
            "run": pd.Timestamp(dates[0]).date(),
            "years_in_service": round((pd.Timestamp(dates[0]) - row.start_date).days / 365.25, 1),
            "n_segments": row.n_seg,
            "share_with_defects": round(float(state["has_def"].mean()), 3),
            "r2": pearson_r2(state["thk_min"], -score),
            "low_is_thinner": bool(corr > 0) if corr == corr else None,
        })
    loss = np.concatenate(losses)
    return pd.DataFrame(rows), float(loss.mean()), float(np.quantile(loss, 0.9))


def run_case2(cfg: dict, passport: pd.DataFrame, profile: pd.DataFrame, vtd: pd.DataFrame) -> dict:
    c = cfg["case2"]
    target_id = int(c["target_id"])
    row = passport.set_index("id").loc[target_id]
    reference, mean_loss, high_loss = reference_losses(
        passport, vtd, profile, exclude_ids={target_id},
        window_m=c["smooth_window_m"], before=c["target_date"],
    )
    segments = _elevation(profile, target_id, row["length_m"])
    if segments["p_z"].std() == 0:
        raise ValueError(f"pipe {target_id} has a flat profile, so elevation cannot separate segments")
    score = elevation_score(segments, c["smooth_window_m"])
    loss = np.clip(mean_loss * (1.0 + c["spread"] * score), 0.0, 0.9)
    pred = pd.DataFrame({
        "id": target_id,
        "segment_id": segments["segment_id"],
        "thickness_pred": row["wall_mm"] * (1.0 - loss),
        "p10": row["wall_mm"] * (1.0 - np.clip(high_loss * (1.0 + c["spread"] * score), 0.0, 0.95)),
        "p90": np.full(len(segments), float(row["wall_mm"])),
        "wall_mm": row["wall_mm"],
        "risk_score": score,
    })
    return {"pred": pred, "reference": reference, "mean_loss": mean_loss, "high_loss": high_loss}
