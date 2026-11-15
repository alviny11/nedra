"""Match defects across two pig runs and draw how depth changes."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from .load import n_segments, seg_of


def match_defects(a: pd.DataFrame, b: pd.DataFrame, d_mm: float, tol_m: float = 0.08):
    """Pair defects of run B with defects of run A.

    `a` carries `x2`, the distance of run A on the odometer of run B.
    Distance is measured on the unrolled pipe, along the axis and around it.
    Returns pairs, unmatched new defects of B, and a mask of confirmed defects of A.
    """
    arc = np.pi * d_mm / 1000.0 / 360.0
    xa = a["x2"].to_numpy()
    ang = a["ang"].to_numpy() % 360.0
    n_a = len(a)
    # 359° and 1° are neighbors. Copies at ±360° make the tree return the short arc.
    points = np.c_[np.tile(xa, 3), np.concatenate([ang - 360.0, ang, ang + 360.0]) * arc]
    tree = cKDTree(points)
    query = np.c_[b["x"].to_numpy(), (b["ang"].to_numpy() % 360.0) * arc]
    dist, index = tree.query(query, distance_upper_bound=tol_m)
    ok = np.isfinite(dist)
    index = np.where(ok, index % max(n_a, 1), 0)
    pairs = pd.DataFrame({
        "dp_a": a["dp"].to_numpy()[index[ok]],
        "dp_b": b["dp"].to_numpy()[ok],
        "x_b": b["x"].to_numpy()[ok],
    })
    confirmed = np.zeros(len(a), dtype=bool)
    confirmed[index[ok]] = True
    return pairs, b[~ok], confirmed


@dataclass
class GrowthModel:
    """Empirical map from depth on the earlier run to depth on the later run."""

    pools: dict = field(default_factory=dict)
    p_confirm: dict = field(default_factory=dict)
    new_rate: float = 0.0
    new_dp: np.ndarray = field(default_factory=lambda: np.array([15.0]))
    n_pairs: int = 0

    @classmethod
    def fit(cls, pairs: pd.DataFrame, new_dp, dp_a_all, confirmed) -> "GrowthModel":
        model = cls(n_pairs=len(pairs))
        growth = (pairs["dp_b"] - pairs["dp_a"]).to_numpy()
        depth_a = pairs["dp_a"].to_numpy()
        dp_a_all = np.asarray(dp_a_all, dtype=float)
        confirmed = np.asarray(confirmed, dtype=bool)
        # Widen the depth window only up to 8 points. Deeper than the paired
        # sample, reuse the nearest depth that has enough pairs: deep defects
        # on the neighbor pipes do not, on average, keep growing.
        pools, confirm = {}, {}
        for depth in range(0, 101):
            for width in (1.0, 2.0, 4.0, 8.0):
                chosen = np.abs(depth_a - depth) <= width
                if chosen.sum() >= 40:
                    pools[depth] = growth[chosen]
                    break
            for width in (1.0, 2.0, 4.0, 8.0):
                chosen = np.abs(dp_a_all - depth) <= width
                if chosen.sum() >= 60:
                    confirm[depth] = float(confirmed[chosen].mean())
                    break
        for depth in range(0, 101):
            model.pools[depth] = pools[min(pools, key=lambda k: abs(k - depth))]
            model.p_confirm[depth] = confirm[min(confirm, key=lambda k: abs(k - depth))]
        model.new_rate = len(new_dp) / max(len(dp_a_all), 1)
        model.new_dp = np.asarray(new_dp, dtype=float)
        return model

    def simulate(self, x, dp, wt, length_m: float, wall_mm: float, n_sim: int = 400,
                 seed: int = 34, pos_sigma: float = 0.0, pos_bump=None,
                 repair_mask=None, repair_prob: float = 0.0, repair_groups=None) -> np.ndarray:
        """Draws of minimum segment thickness, shape (n_sim, n_seg).

        `pos_sigma` is the position error, in metres, where `pos_bump` is 1.
        The draw is one odometer error for the whole run, scaled along the pipe.
        `repair_mask` marks defects on joints the earlier report told us to cut out.
        Each such joint is replaced, on its own, with probability `repair_prob`.
        """
        rng = np.random.default_rng(seed)
        x, dp, wt = (np.asarray(v, dtype=float) for v in (x, dp, wt))
        n_seg = n_segments(length_m)
        bump = np.zeros_like(x) if pos_bump is None else np.asarray(pos_bump, dtype=float)
        depth_bin = np.clip(np.rint(dp).astype(int), 0, 100)
        groups = {d: np.where(depth_bin == d)[0] for d in np.unique(depth_bin)}
        p_conf = np.array([self.p_confirm[d] for d in depth_bin])
        seg0 = seg_of(x, length_m)
        wt_seg = pd.Series(wt).groupby(seg0).median().reindex(range(n_seg)).interpolate(limit_direction="both")
        wt_seg = wt_seg.fillna(wall_mm).to_numpy()
        on_repair = np.zeros(len(x), dtype=bool) if repair_mask is None else np.asarray(repair_mask, dtype=bool)
        group_id = np.zeros(len(x), dtype=int) if repair_groups is None else np.asarray(repair_groups)
        repair_ids = np.unique(group_id[on_repair])
        repair_index = {g: np.where(on_repair & (group_id == g))[0] for g in repair_ids}
        out = np.empty((n_sim, n_seg))
        for draw_i in range(n_sim):
            if pos_sigma > 0:
                seg = seg_of(x + rng.normal(0.0, pos_sigma) * bump, length_m)
            else:
                seg = seg0
            dp_new = np.empty_like(dp)
            for depth, idx in groups.items():
                dp_new[idx] = depth + rng.choice(self.pools[depth], size=len(idx))
            residual = wt * (1.0 - np.clip(dp_new, 0.0, 95.0) / 100.0)
            alive = rng.random(len(x)) < p_conf
            present = np.ones(len(x), dtype=bool)
            # Always draw, so a different repair probability does not rewind the stream.
            draw = rng.random(max(len(repair_ids), 1))
            for joint, chance in zip(repair_ids, draw):
                if chance < repair_prob:
                    present[repair_index[joint]] = False
            alive &= present
            mins = np.full(n_seg, np.inf)
            np.minimum.at(mins, seg[alive], residual[alive])
            counts = rng.poisson(self.new_rate * np.bincount(seg[present], minlength=n_seg))
            if counts.sum():
                seg_new = np.repeat(np.arange(n_seg), counts)
                fresh = wt_seg[seg_new] * (1.0 - rng.choice(self.new_dp, size=len(seg_new)) / 100.0)
                np.minimum.at(mins, seg_new, fresh)
            out[draw_i] = np.where(np.isfinite(mins), mins, wt_seg)
        return out


def summarize(sims: np.ndarray) -> pd.DataFrame:
    return pd.DataFrame({
        "segment_id": np.arange(sims.shape[1]),
        "thickness_pred": sims.mean(axis=0),
        "p10": np.quantile(sims, 0.10, axis=0),
        "p90": np.quantile(sims, 0.90, axis=0),
    })
