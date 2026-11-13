"""Semantic validation of a public scenario (mirrors packages/physics-core/src/validation/validateScenario.ts).

Structural validation is done by Pydantic. Both implementations are run against the same fixtures in
tests/fixtures (TS: vitest + Ajv, Python: pytest), so they must accept/reject the same files.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..schemas.domain import SCHEMA_VERSION, PublicScenarioConfig


@dataclass
class Issue:
    code: str
    message: str
    fieldPath: str | None = None


@dataclass
class ValidationResult:
    ok: bool
    errors: list[Issue] = field(default_factory=list)
    warnings: list[Issue] = field(default_factory=list)


def validate_public_scenario(cfg: PublicScenarioConfig) -> ValidationResult:
    errors: list[Issue] = []
    warnings: list[Issue] = []

    def err(code: str, msg: str, path: str | None = None) -> None:
        errors.append(Issue(code, msg, path))

    if cfg.schemaVersion != SCHEMA_VERSION:
        err("MODEL_SCHEMA_MISMATCH", f"schemaVersion {cfg.schemaVersion} != {SCHEMA_VERSION}", "schemaVersion")
    ids: set[str] = set()

    def dup(i: str, path: str) -> None:
        if i in ids:
            err("INVALID_TOPOLOGY", f"Duplicate id {i}", path)
        ids.add(i)

    fluids = {f.id: f for f in cfg.fluidProfiles}
    for i, f in enumerate(cfg.fluidProfiles):
        p = f"fluidProfiles[{i}]"
        if f.oil is None and f.water is None:
            err("INVALID_SCHEMA", f"Profile {f.id} has no liquid phase", p)
        if not f.validTemperatureK[0] < f.validTemperatureK[1]:
            err("INVALID_SCHEMA", "validTemperatureK must be increasing", f"{p}.validTemperatureK")
        if not f.validPressurePa[0] < f.validPressurePa[1]:
            err("INVALID_SCHEMA", "validPressurePa must be increasing", f"{p}.validPressurePa")
        for ph in (f.oil, f.water):
            if ph is None:
                continue
            vm = ph.viscosityModel
            if vm.kind == "table_log":
                if len(vm.temperatureK) != len(vm.viscosityPaS):
                    err("INVALID_SCHEMA", "viscosity table length mismatch", p)
                if any(b <= a for a, b in zip(vm.temperatureK, vm.temperatureK[1:])):
                    err("INVALID_SCHEMA", "viscosity table temperatures must increase", p)

    nodes = {n.id: n for n in cfg.nodes}
    for i, n in enumerate(cfg.nodes):
        p = f"nodes[{i}]"
        dup(n.id, p)
        if n.kind == "pressure_boundary" and (n.boundary is None or not (n.boundary.pressurePa or 0) > 0):
            err("INVALID_TOPOLOGY", f"Pressure boundary {n.id} needs a positive absolute pressure", f"{p}.boundary.pressurePa")
        if n.kind == "mass_flow_source" and (n.boundary is None or n.boundary.massFlowKgS is None):
            err("INVALID_TOPOLOGY", f"Source {n.id} needs a non-negative mass flow", f"{p}.boundary.massFlowKgS")

    links = {}
    node_devices: dict[str, int] = {}
    node_pipes: dict[str, int] = {}
    for i, lk in enumerate(cfg.links):
        p = f"links[{i}]"
        dup(lk.id, p)
        links[lk.id] = lk
        if lk.fromNodeId not in nodes:
            err("INVALID_TOPOLOGY", f"Link {lk.id}: unknown fromNodeId {lk.fromNodeId}", f"{p}.fromNodeId")
        if lk.toNodeId not in nodes:
            err("INVALID_TOPOLOGY", f"Link {lk.id}: unknown toNodeId {lk.toNodeId}", f"{p}.toNodeId")
        if lk.fromNodeId == lk.toNodeId:
            err("INVALID_TOPOLOGY", f"Link {lk.id} connects a node to itself", p)
        if lk.kind == "pipe":
            for nid in (lk.fromNodeId, lk.toNodeId):
                node_pipes[nid] = node_pipes.get(nid, 0) + 1
            if not (0 <= lk.roughnessM < 0.05 * lk.innerDiameterM):
                err("INVALID_SCHEMA", f"Pipe {lk.id}: roughness out of range", f"{p}.roughnessM")
            if lk.fluidProfileId not in fluids:
                err("INVALID_TOPOLOGY", f"Pipe {lk.id}: unknown fluid profile {lk.fluidProfileId}", f"{p}.fluidProfileId")
            ep = lk.elevationProfile
            if abs(ep[0].distanceM) > 1e-6 or abs(ep[-1].distanceM - lk.lengthM) > 1e-6:
                err("INVALID_SCHEMA", f"Pipe {lk.id}: elevation profile must span [0, length]", f"{p}.elevationProfile")
            if any(b.distanceM <= a.distanceM for a, b in zip(ep, ep[1:])):
                err("INVALID_SCHEMA", f"Pipe {lk.id}: elevation profile distances must increase", f"{p}.elevationProfile")
            nf, nt = nodes.get(lk.fromNodeId), nodes.get(lk.toNodeId)
            if nf is not None and abs(nf.elevationM - ep[0].elevationM) > 0.05:
                err("INVALID_TOPOLOGY", f"Pipe {lk.id}: start elevation differs from node {nf.id}", f"{p}.elevationProfile")
            if nt is not None and abs(nt.elevationM - ep[-1].elevationM) > 0.05:
                err("INVALID_TOPOLOGY", f"Pipe {lk.id}: end elevation differs from node {nt.id}", f"{p}.elevationProfile")
            if lk.thermal.referenceOuterDiameterM < lk.innerDiameterM:
                err("INVALID_SCHEMA", f"Pipe {lk.id}: thermal data inconsistent (U >= 0, D_o >= D)", f"{p}.thermal")
        else:
            for nid in (lk.fromNodeId, lk.toNodeId):
                node_devices[nid] = node_devices.get(nid, 0) + 1
            if lk.kind == "pump":
                q, h = lk.curve.flowM3S, lk.curve.headM
                if len(q) != len(h):
                    err("INVALID_SCHEMA", f"Pump {lk.id}: curve needs >= 3 points", f"{p}.curve")
                if any(not (h[k] < h[k - 1] and q[k] > q[k - 1]) for k in range(1, min(len(q), len(h)))):
                    err("INVALID_SCHEMA", f"Pump {lk.id}: head must decrease with increasing flow", f"{p}.curve")
            else:
                th, K = lk.characteristic.opening, lk.characteristic.lossCoefficientK
                if len(th) != len(K):
                    err("INVALID_SCHEMA", f"Valve {lk.id}: characteristic table mismatch", f"{p}.characteristic")
                if any(not (th[k] > th[k - 1] and K[k] <= K[k - 1]) for k in range(1, min(len(th), len(K)))):
                    err("INVALID_SCHEMA", f"Valve {lk.id}: opening must increase and K must not increase", f"{p}.characteristic")
    for nid, cnt in node_devices.items():
        n = nodes.get(nid)
        if n is None:
            continue
        if cnt > 1:
            err("INVALID_TOPOLOGY", f"Node {nid} connects {cnt} devices; put a pipe between devices", "links")
        if n.kind in ("mass_flow_source", "closed_end"):
            err("INVALID_TOPOLOGY", f"Device port {nid} cannot be a {n.kind}", "links")
        if n.kind != "pressure_boundary" and node_pipes.get(nid, 0) == 0:
            err("INVALID_TOPOLOGY", f"Device port {nid} needs at least one pipe or must be a pressure boundary", "links")
    for n in cfg.nodes:
        if node_pipes.get(n.id, 0) + node_devices.get(n.id, 0) == 0:
            err("INVALID_TOPOLOGY", f"Node {n.id} is not connected", "nodes")

    # connected components need a pressure boundary (no trapped volumes)
    adj: dict[str, list[str]] = {}
    for lk in cfg.links:
        if lk.fromNodeId in nodes and lk.toNodeId in nodes:
            adj.setdefault(lk.fromNodeId, []).append(lk.toNodeId)
            adj.setdefault(lk.toNodeId, []).append(lk.fromNodeId)
    seen: set[str] = set()
    for n in cfg.nodes:
        if n.id in seen:
            continue
        comp, stack = [], [n.id]
        seen.add(n.id)
        while stack:
            c = stack.pop()
            comp.append(c)
            for nb in adj.get(c, []):
                if nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        if not any(nodes[c].kind == "pressure_boundary" for c in comp):
            err("INVALID_TOPOLOGY", f"Component {{{', '.join(comp)}}} has no pressure boundary: isolated liquid volume is not supported", "nodes")

    for n in cfg.nodes:
        if n.boundary is None:
            continue
        for lk in cfg.links:
            if lk.kind != "pipe" or n.id not in (lk.fromNodeId, lk.toNodeId):
                continue
            f = fluids.get(lk.fluidProfileId)
            if f is None:
                continue
            tlo, thi = f.validTemperatureK
            if not tlo <= n.boundary.temperatureK <= thi:
                err("PROFILE_OUT_OF_RANGE", f"Node {n.id}: temperature outside profile {f.id} range", "nodes")
            if f.oil is not None and f.water is not None:
                ylo, yhi = f.compositionBounds.waterMassFraction
                if not ylo <= n.boundary.waterMassFraction <= yhi:
                    err("PROFILE_OUT_OF_RANGE", f"Node {n.id}: water fraction outside profile {f.id} bounds", "nodes")
            if n.boundary.pressurePa is not None and n.boundary.pressurePa < f.phaseBoundaryModel.minPressurePa:
                err("UNSUPPORTED_PHASE_REGIME", f"Node {n.id}: boundary pressure below liquid-model limit of {f.id}", "nodes")

    for i, s in enumerate(cfg.sensors):
        p = f"sensors[{i}]"
        dup(s.id, p)
        if s.nodeId:
            if s.nodeId not in nodes:
                err("INVALID_TOPOLOGY", f"Sensor {s.id}: unknown node {s.nodeId}", f"{p}.nodeId")
        elif s.edgeId:
            lk = links.get(s.edgeId)
            if lk is None or lk.kind != "pipe":
                err("INVALID_TOPOLOGY", f"Sensor {s.id}: edge {s.edgeId} is not a pipe", f"{p}.edgeId")
            elif s.distanceM is None or s.distanceM > lk.lengthM:
                err("INVALID_TOPOLOGY", f"Sensor {s.id}: distance outside [0, L]", f"{p}.distanceM")
        else:
            err("INVALID_TOPOLOGY", f"Sensor {s.id}: needs nodeId or edgeId+distanceM", p)
        if not s.rangeSI[0] < s.rangeSI[1]:
            err("INVALID_SCHEMA", f"Sensor {s.id}: range must be increasing", f"{p}.rangeSI")
        if s.role == "boundary_input" and (not s.boundaryNodeId or s.boundaryNodeId not in nodes):
            err("INVALID_TOPOLOGY", f"Boundary-input sensor {s.id} must name its boundary node", f"{p}.boundaryNodeId")

    for i, c in enumerate(cfg.commands):
        p = f"commands[{i}]"
        if c.kind == "pump_speed" and getattr(links.get(c.targetId), "kind", None) != "pump":
            err("INVALID_TOPOLOGY", f"Command {c.id}: {c.targetId} is not a pump", p)
        if c.kind == "valve_opening" and getattr(links.get(c.targetId), "kind", None) != "valve":
            err("INVALID_TOPOLOGY", f"Command {c.id}: {c.targetId} is not a valve", p)
        if c.kind == "boundary_pressure" and getattr(nodes.get(c.targetId), "kind", None) != "pressure_boundary":
            err("INVALID_TOPOLOGY", f"Command {c.id}: {c.targetId} is not a pressure boundary", p)
        if c.kind == "source_mass_flow" and getattr(nodes.get(c.targetId), "kind", None) != "mass_flow_source":
            err("INVALID_TOPOLOGY", f"Command {c.id}: {c.targetId} is not a source", p)
    return ValidationResult(ok=not errors, errors=errors, warnings=warnings)
