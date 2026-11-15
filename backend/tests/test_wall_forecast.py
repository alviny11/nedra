"""The neighbor-pipe check and the two forecast pipes."""
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from wall_forecast.align import estimate_shift
from wall_forecast.forecast import config, run_case1, run_case2
from wall_forecast.growth import match_defects
from wall_forecast.load import load_joints, load_passport, load_profile, load_vtd, n_segments, seg_of
from wall_forecast.metrics import pearson_r2

RAW = Path(__file__).resolve().parents[2] / "data" / "ili"


def test_segment_index_follows_floor_of_distance():
    assert n_segments(5248.4) == 525
    assert n_segments(44.7) == 5
    assert n_segments(100.0) == 11
    assert list(seg_of([-0.3, 0, 9.99, 10, 44.69, 501.0], 44.7)) == [0, 0, 0, 1, 4, 4]


def test_pearson_r2_ignores_scale_and_rejects_a_constant():
    y = np.array([1.0, 2.0, 3.0, 4.0])
    assert abs(pearson_r2(y, 2 * y + 5) - 1.0) < 1e-12
    assert abs(pearson_r2(y, -y) - 1.0) < 1e-12
    assert np.isnan(pearson_r2(y, np.ones(4)))
    assert np.isnan(pearson_r2([0.1, 0.1, 0.1], [1.0, 2.0, 3.0]))


def test_angle_wraps_across_zero():
    earlier = pd.DataFrame({"x2": [1.0, 5.0], "ang": [359.0, 180.0], "dp": [20.0, 15.0]})
    later = pd.DataFrame({"x": [1.0, 5.0], "ang": [1.0, 180.0], "dp": [22.0, 15.0]})
    pairs, new, confirmed = match_defects(earlier, later, d_mm=219.0, tol_m=0.08)
    assert len(pairs) == 2 and len(new) == 0 and confirmed.all()
    same = pd.DataFrame({"x2": [1.0], "ang": [360.0], "dp": [10.0]})
    other = pd.DataFrame({"x": [1.0], "ang": [0.0], "dp": [10.0]})
    assert len(match_defects(same, other, 219.0, 0.08)[0]) == 1


def test_density_shift_recovers_a_known_offset():
    rng = np.random.default_rng(0)
    xa = np.sort(rng.uniform(0, 500, 600))
    xb = np.concatenate([xa + 7.0 + rng.normal(0, 0.05, len(xa)), rng.uniform(0, 500, 60)])
    shift, corr = estimate_shift(xa, xb, 50, 450, 0.0, span=15)
    assert abs(shift - 7.0) <= 0.25 and corr > 0.7


@pytest.fixture(scope="module")
def tables():
    return {
        "passport": load_passport(RAW),
        "vtd": load_vtd(RAW),
        "profile": load_profile(RAW),
        "joints": load_joints(RAW),
    }


def test_neighbor_check_matches_the_held_out_blocks(tables):
    cfg = config()
    case1 = run_case1(cfg, tables["passport"], tables["vtd"], tables["joints"])
    assert case1["val_section"] == 1250011604
    assert list(case1["by_block"]["segments"]) == ["0–9", "10–19", "20–29", "30–39", "40–49"]
    row = case1["validation"].set_index("method").loc["growth model + 5th percentile"]
    assert row["n_segments"] == 50
    assert abs(row["r2"] - 0.7598) < 1e-4
    assert abs(row["mae_mm"] - 0.1957) < 1e-4
    assert abs(case1["drift_ends"][0] - 1.82) < 0.02
    assert abs(case1["drift_ends"][1] - 7.47) < 0.02
    pred = case1["pred"]
    assert len(pred) == 525
    assert pred["thickness_pred"].between(0, 8.0).all()
    assert abs(pred["thickness_pred"].min() - 4.2740) < 1e-3
    assert abs(pred["thickness_pred"].mean() - 5.9393) < 1e-3
    assert abs(pred["thickness_pred"].max() - 7.7389) < 1e-3


def test_hidden_block_does_not_enter_the_shift_or_the_growth_law(tables):
    cfg = config()
    cfg["case1"]["n_sim"] = 40
    base = run_case1(cfg, tables["passport"], tables["vtd"], tables["joints"])["val_points"]
    pipe_id = int(base["id"].iloc[0])
    later = pd.Timestamp(cfg["case1"]["target_run"])
    lo, hi = 200.0, 300.0
    spoiled = tables["vtd"].copy()
    mask = (spoiled["id"] == pipe_id) & (spoiled["date"] == later) & (spoiled["x"] >= lo) & (spoiled["x"] < hi)
    assert mask.sum() > 100
    spoiled.loc[mask, "dp"] = 11.0
    spoiled.loc[mask, "rw"] = spoiled.loc[mask, "wt"] * 0.89
    joints = tables["joints"].copy()
    origin = 5293.1
    moved = (joints["date"] == later) & (joints["js"] - origin >= lo) & (joints["js"] - origin < hi)
    assert moved.sum() >= 5
    joints.loc[moved, "js"] += 3.0
    pert = run_case1(cfg, tables["passport"], spoiled, joints)["val_points"]
    block = base["block"] == 2
    for col in ("pred_pers", "pred_q05", "pred_mc", "pred_blend"):
        assert np.allclose(base.loc[block, col], pert.loc[block, col]), col
    assert not np.allclose(base.loc[block, "fact"], pert.loc[block, "fact"])


def test_case2_stays_on_the_passport_wall_and_uses_only_earlier_runs(tables):
    cfg = config()
    case2 = run_case2(cfg, tables["passport"], tables["profile"], tables["vtd"])
    pred, ref = case2["pred"], case2["reference"]
    assert len(pred) == 1475
    assert pred["thickness_pred"].nunique() > 100
    assert (pred["thickness_pred"] <= 4.5).all()
    assert (pred["p10"] <= pred["thickness_pred"]).all()
    assert pred["thickness_pred"].between(0.3 * 4.5, 4.5).all()
    assert 1250009583 not in set(ref["id"])
    assert (pd.to_datetime(ref["run"]) < pd.Timestamp("2022-07-01")).all()
    assert ref["r2"].between(0, 0.3).all()
    assert abs(pred["thickness_pred"].min() - 3.042) < 1e-3
    assert abs(pred["thickness_pred"].mean() - 3.5691) < 1e-3
    assert abs(pred["thickness_pred"].max() - 4.427) < 1e-3
    # The elevation signal on other pipes is weak. This case does not claim a high r².
    assert ref["r2"].max() < 0.2
