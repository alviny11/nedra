"""Independent reference solutions (NumPy/SciPy), used to check the TypeScript solver.

These are different implementations / closed forms, not calls into the TS code:
  - Hagen-Poiseuille laminar pressure drop
  - Colebrook-White by SciPy root finding
  - Joukowsky surge and first arrival L/c
  - exponential steady cooling of a pipe
  - Wood's mixture sound speed
  - water-hammer MOC in head/discharge form (Wylie & Streeter) with explicit friction
"""
from __future__ import annotations

import math

import numpy as np
from scipy.optimize import brentq

G = 9.80665


def hagen_poiseuille_dp(mu: float, L: float, Q: float, D: float) -> float:
    return 128.0 * mu * L * Q / (math.pi * D**4)


def colebrook(re: float, rel_rough: float) -> float:
    if re <= 2000:
        return 64.0 / re

    def g(f: float) -> float:
        return 1 / math.sqrt(f) + 2 * math.log10(rel_rough / 3.7 + 2.51 / (re * math.sqrt(f)))

    return brentq(g, 1e-4, 1.0, xtol=1e-14)


def joukowsky_dp(rho: float, c: float, du: float) -> float:
    return rho * c * du


def steady_cooling(T_in: float, T_amb: float, U: float, Do: float, x: float, mdot: float, cp: float) -> float:
    return T_amb + (T_in - T_amb) * math.exp(-U * math.pi * Do * x / (mdot * cp))


def wood_speed(phases: list[tuple[float, float, float]]) -> float:
    """phases: (alpha, rho, c)"""
    rho_m = sum(a * r for a, r, _ in phases)
    inv = sum(a / (r * c * c) for a, r, c in phases)
    return 1 / math.sqrt(rho_m * inv)


def water_hammer_hq(L: float, D: float, c: float, rho: float, nu: float, rough: float, H_res: float, Q0: float, n: int, t_end: float, x_probe: float):
    """Reservoir -> pipe -> instantaneously closed valve. Head/discharge MOC, Courant 1, explicit friction.

    Returns (t, H_valve, H_probe) with heads relative to the reservoir level datum.
    """
    A = math.pi * D * D / 4
    dx = L / n
    dt = dx / c
    B = c / (G * A)
    u0 = Q0 / A
    f = colebrook(abs(u0) * D / nu, rough / D) if Q0 != 0 else 0.02
    R = f * dx / (2 * G * D * A * A)
    x = np.linspace(0, L, n + 1)
    Q = np.full(n + 1, Q0)
    H = H_res - (f * x / D) * u0 * abs(u0) / (2 * G)
    k_probe = int(round(x_probe / dx))
    ts, hv, hp = [], [], []
    t = 0.0
    while t < t_end:
        CP = H[:-1] + B * Q[:-1] - R * Q[:-1] * np.abs(Q[:-1])
        CM = H[1:] - B * Q[1:] + R * Q[1:] * np.abs(Q[1:])
        Hn = np.empty_like(H)
        Qn = np.empty_like(Q)
        Hn[1:-1] = 0.5 * (CP[:-1] + CM[1:])
        Qn[1:-1] = (CP[:-1] - CM[1:]) / (2 * B)
        Hn[0] = H_res
        Qn[0] = (H_res - CM[0]) / B
        Qn[-1] = 0.0
        Hn[-1] = CP[-1]
        H, Q = Hn, Qn
        t += dt
        ts.append(t)
        hv.append(H[-1])
        hp.append(H[k_probe])
    return np.array(ts), np.array(hv), np.array(hp)
