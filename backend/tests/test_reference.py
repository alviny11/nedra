"""Independent physics checks of the TS solver (through the headless runner) against
analytic solutions, an independent NumPy MOC, and EPA EPANET (WNTR)."""
import json
import math
import warnings

import numpy as np
import pytest

from reference.analytic import G, colebrook, hagen_poiseuille_dp, joukowsky_dp, steady_cooling, water_hammer_hq, wood_speed
from tests.conftest import needs_runner, run_runner


def test_closed_forms_sanity():
    # Hagen-Poiseuille: dp for Q gives back Q through the inverse
    Q = 2.454e-6
    dp = hagen_poiseuille_dp(0.1, 100, Q, 0.01)
    assert abs(dp - 1e5) / 1e5 < 0.01
    # Colebrook in the smooth turbulent range close to Blasius at Re=1e4 (within 4 %)
    assert abs(colebrook(1e4, 0.0) / (0.3164 * 1e4**-0.25) - 1) < 0.04
    assert joukowsky_dp(1000, 1200, 0.5) == 6e5
    assert steady_cooling(353.15, 283.15, 20, 0.12, 0, 8, 4180) == 353.15
    # Wood: liquid limit and the research-note example (88 / 273 / 565 m/s)
    assert abs(wood_speed([(1.0, 850, 1300)]) - 1300) < 1e-9
    for p_bar, ref in ((1, 88), (10, 273), (50, 565)):
        rho_g = p_bar * 1e5 / (500 * 320)
        c_g = math.sqrt(1.3 * 500 * 320)
        assert abs(wood_speed([(0.98, 850, 1300), (0.02, rho_g, c_g)]) - ref) < 1.0


@needs_runner
def test_water_hammer_against_independent_moc_and_joukowsky(tmp_path):
    out = tmp_path / "h.json"
    run_runner("bench-hammer", "--out", str(out), "--reach", "10")
    d = json.loads(out.read_text())
    c, rho, u0, L, pR = d["c"], d["rho"], d["u0"], d["L"], d["pR"]
    t = np.array(d["t"])
    pv = np.array(d["pValve"])
    ps = np.array(d["pSensor"])
    # Joukowsky (first step after closure) within 2 %
    jump = pv[1] - d["pValve0"]
    assert abs(jump / joukowsky_dp(rho, c, u0) - 1) < 0.02
    # first arrival at the sensor (900 m from the valve) within 2 %
    dpJ = joukowsky_dp(rho, c, u0)
    i = int(np.argmax(ps - ps[0] > 0.5 * dpJ))
    assert abs((t[i] - t[0] + (t[1] - t[0])) / (900 / c) - 1) < 0.02
    # independent head-discharge MOC with the same c, grid and steady friction
    n = d["reaches"]
    A = math.pi * d["D"] ** 2 / 4
    tr, hv, hp = water_hammer_hq(L, d["D"], c, rho, 1e-6, 0.0, pR / (rho * G), u0 * A, n, t[-1] + 1e-9, 300)
    m = min(len(tr), len(t))
    pv_ref = hv[:m] * rho * G
    ps_ref = hp[:m] * rho * G
    scale = dpJ
    rmse_v = float(np.sqrt(np.mean((pv[:m] - pv_ref) ** 2))) / scale
    rmse_s = float(np.sqrt(np.mean((ps[:m] - ps_ref) ** 2))) / scale
    assert rmse_v < 0.02, rmse_v
    assert rmse_s < 0.02, rmse_s


@needs_runner
def test_steady_network_against_epanet(tmp_path):
    from reference.epanet_check import run_epanet

    out = tmp_path / "s.json"
    run_runner("bench-steady", "--out", str(out))
    d = json.loads(out.read_text())
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        heads, flows = run_epanet(d["network"])
    drop = 30.0  # head difference between the two reservoirs
    for j in ("J1", "J2", "J3", "S"):
        assert abs(heads[j] - d["headsM"][j]) < 0.01 * drop, (j, heads[j], d["headsM"][j])
    for p in ("P1", "P2", "P3", "P4", "P5", "P6"):
        assert abs(flows[p] - d["flowsM3S"][p]) <= 0.01 * abs(flows[p]) + 1e-5, (p, flows[p], d["flowsM3S"][p])
