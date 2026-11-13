"""Write the measured deviations of the independent physics checks to a JSON report.

    cd backend && python -m reference.report --out ../data/benchmarks/verification/reference.json

Same comparisons as tests/test_reference.py, but the numbers are stored instead of only asserted.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import tempfile
import warnings
from pathlib import Path

import numpy as np

from reference.analytic import G, joukowsky_dp, water_hammer_hq, wood_speed

REPO = Path(__file__).resolve().parents[2]
RUNNER = REPO / "tools" / "headless-runner" / "dist" / "pipetwin-runner.mjs"


def _runner(*args: str) -> None:
    subprocess.run(["node", str(RUNNER), *args], check=True, capture_output=True, text=True)


def hammer(tmp: Path) -> dict:
    out = tmp / "h.json"
    _runner("bench-hammer", "--out", str(out), "--reach", "10")
    d = json.loads(out.read_text())
    c, rho, u0, L, pR = d["c"], d["rho"], d["u0"], d["L"], d["pR"]
    t = np.array(d["t"])
    pv = np.array(d["pValve"])
    ps = np.array(d["pSensor"])
    dpJ = joukowsky_dp(rho, c, u0)
    jump = pv[1] - d["pValve0"]
    i = int(np.argmax(ps - ps[0] > 0.5 * dpJ))
    arrival = t[i] - t[0] + (t[1] - t[0])
    n = d["reaches"]
    A = math.pi * d["D"] ** 2 / 4
    tr, hv, hp = water_hammer_hq(L, d["D"], c, rho, 1e-6, 0.0, pR / (rho * G), u0 * A, n, t[-1] + 1e-9, 300)
    m = min(len(tr), len(t))
    rmse_v = float(np.sqrt(np.mean((pv[:m] - hv[:m] * rho * G) ** 2))) / dpJ
    rmse_s = float(np.sqrt(np.mean((ps[:m] - hp[:m] * rho * G) ** 2))) / dpJ
    return {
        "case": "single pipe, instantaneous valve closure",
        "L_m": L, "c_mps": c, "rho": rho, "u0_mps": u0,
        "joukowskyPa": dpJ, "simulatedJumpPa": float(jump), "joukowskyRelErr": float(jump / dpJ - 1),
        "arrivalS": float(arrival), "arrivalRefS": 900 / c, "arrivalRelErr": float(arrival / (900 / c) - 1),
        "independentMocRmseValveRel": rmse_v, "independentMocRmseSensorRel": rmse_s,
        "acceptance": "|rel err| < 0.02 each",
    }


def steady(tmp: Path) -> dict:
    from reference.epanet_check import run_epanet

    out = tmp / "s.json"
    _runner("bench-steady", "--out", str(out))
    d = json.loads(out.read_text())
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        heads, flows = run_epanet(d["network"])
    dh = {j: float(heads[j] - d["headsM"][j]) for j in ("J1", "J2", "J3", "S")}
    dq = {p: float((d["flowsM3S"][p] - flows[p]) / flows[p]) for p in ("P1", "P2", "P3", "P4", "P5", "P6")}
    return {
        "case": "6-pipe loop network between two reservoirs (30 m head difference), water, Darcy-Weisbach",
        "headDiffM": dh, "maxAbsHeadDiffM": max(abs(v) for v in dh.values()),
        "flowRelDiff": dq, "maxAbsFlowRelDiff": max(abs(v) for v in dq.values()),
        "acceptance": "|dH| < 0.3 m (1 % of 30 m); |dQ| <= 1 % + 1e-5 m3/s",
    }


def wood() -> dict:
    rows = []
    for p_bar, ref in ((1, 88), (10, 273), (50, 565)):
        rho_g = p_bar * 1e5 / (500 * 320)
        c_g = math.sqrt(1.3 * 500 * 320)
        rows.append({"pBar": p_bar, "researchNoteMps": ref, "computedMps": wood_speed([(0.98, 850, 1300), (0.02, rho_g, c_g)])})
    return {"case": "Wood speed, 2 % gas by volume in oil", "rows": rows}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        res = {"waterHammer": hammer(tmp), "steadyVsEpanet": steady(tmp), "wood": wood()}
    Path(a.out).write_text(json.dumps(res, indent=2, ensure_ascii=False))
    print(json.dumps({"joukowskyRelErr": res["waterHammer"]["joukowskyRelErr"], "arrivalRelErr": res["waterHammer"]["arrivalRelErr"],
                      "mocRmse": [res["waterHammer"]["independentMocRmseValveRel"], res["waterHammer"]["independentMocRmseSensorRel"]],
                      "epanetMaxDH": res["steadyVsEpanet"]["maxAbsHeadDiffM"], "epanetMaxDQ": res["steadyVsEpanet"]["maxAbsFlowRelDiff"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
