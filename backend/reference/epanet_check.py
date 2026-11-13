"""External reference for the steady water network: EPA EPANET through WNTR (EpanetSimulator).

EPANET uses Darcy-Weisbach with the Swamee-Jain approximation in turbulent flow, so agreement with
our Colebrook solver is expected at the ~1 % level, not to machine precision.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import wntr

G = 9.80665
P_ATM = 101325.0


def run_epanet(network: dict, rho: float = 1000.0) -> tuple[dict[str, float], dict[str, float]]:
    wn = wntr.network.WaterNetworkModel()
    wn.options.hydraulic.headloss = "D-W"
    wn.options.hydraulic.viscosity = 1.0
    wn.options.hydraulic.specific_gravity = 1.0
    for n in network["nodes"]:
        z = n["elevationM"]
        if n["kind"] == "pressure_boundary":
            head = z + (n["boundary"]["pressurePa"] - P_ATM) / (rho * G)
            wn.add_reservoir(n["id"], base_head=head)
        elif n["kind"] == "mass_flow_source":
            wn.add_junction(n["id"], base_demand=-n["boundary"]["massFlowKgS"] / rho, elevation=z)
        else:
            wn.add_junction(n["id"], base_demand=0.0, elevation=z)
    for lk in network["links"]:
        # WNTR works in SI internally: D-W roughness is passed in metres
        wn.add_pipe(lk["id"], lk["fromNodeId"], lk["toNodeId"], length=lk["lengthM"], diameter=lk["innerDiameterM"], roughness=lk["roughnessM"], minor_loss=0.0)
    sim = wntr.sim.EpanetSimulator(wn)
    # EPANET writes .inp/.rpt/.bin scratch files: keep them out of the working directory
    with tempfile.TemporaryDirectory() as td:
        res = sim.run_sim(file_prefix=str(Path(td) / "epanet"))
    heads = {k: float(v) for k, v in res.node["head"].iloc[0].items()}
    flows = {k: float(v) for k, v in res.link["flowrate"].iloc[0].items()}
    return heads, flows
