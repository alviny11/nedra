import type { PublicScenarioConfig, ValidationIssue, ValidationResult } from '@pipetwin/contracts';
import { SCHEMA_VERSION } from '@pipetwin/contracts';

/**
 * Semantic validation of a public scenario (topology, references, physical ranges, boundary
 * well-posedness). Structural JSON-schema validation is done separately (Ajv / Pydantic) against
 * the same schema; both are checked against shared fixtures.
 */
export function validateScenario(cfg: PublicScenarioConfig): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: ValidationIssue['code'], message: string, fieldPath?: string): void => {
    errors.push({ code, message, fieldPath });
  };
  const warn = (code: ValidationIssue['code'], message: string, fieldPath?: string): void => {
    warnings.push({ code, message, fieldPath });
  };
  if (cfg.schemaVersion !== SCHEMA_VERSION) err('MODEL_SCHEMA_MISMATCH', `schemaVersion ${cfg.schemaVersion} != ${SCHEMA_VERSION}`, 'schemaVersion');

  const ids = new Set<string>();
  const dup = (id: string, path: string): void => {
    if (ids.has(id)) err('INVALID_TOPOLOGY', `Duplicate id ${id}`, path);
    ids.add(id);
  };
  const fluids = new Map(cfg.fluidProfiles.map((f) => [f.id, f]));
  cfg.fluidProfiles.forEach((f, i) => {
    const p = `fluidProfiles[${i}]`;
    if (!f.oil && !f.water) err('INVALID_SCHEMA', `Profile ${f.id} has no liquid phase`, p);
    if (!(f.validTemperatureK[0] < f.validTemperatureK[1])) err('INVALID_SCHEMA', 'validTemperatureK must be increasing', `${p}.validTemperatureK`);
    if (!(f.validPressurePa[0] < f.validPressurePa[1])) err('INVALID_SCHEMA', 'validPressurePa must be increasing', `${p}.validPressurePa`);
    for (const ph of [f.oil, f.water]) {
      if (!ph) continue;
      if (!(ph.densityModel.rhoRefKgM3 > 0 && ph.bulkModulusPa > 0 && ph.heatCapacityJkgK > 0)) err('INVALID_SCHEMA', `Profile ${f.id}: density, bulk modulus and heat capacity must be positive`, p);
      const vm = ph.viscosityModel;
      if (vm.kind === 'table_log') {
        if (vm.temperatureK.length !== vm.viscosityPaS.length || vm.temperatureK.length < 2) err('INVALID_SCHEMA', 'viscosity table length mismatch', p);
        for (let k = 1; k < vm.temperatureK.length; k++) if (!(vm.temperatureK[k]! > vm.temperatureK[k - 1]!)) err('INVALID_SCHEMA', 'viscosity table temperatures must increase', p);
        if (vm.viscosityPaS.some((v) => !(v > 0))) err('INVALID_SCHEMA', 'viscosities must be positive', p);
      }
      if (vm.kind === 'constant' && !(vm.muPaS > 0)) err('INVALID_SCHEMA', 'viscosity must be positive', p);
    }
  });

  const nodes = new Map(cfg.nodes.map((n) => [n.id, n]));
  cfg.nodes.forEach((n, i) => {
    const p = `nodes[${i}]`;
    dup(n.id, p);
    if (n.kind === 'pressure_boundary') {
      if (!n.boundary || !(n.boundary.pressurePa! > 0)) err('INVALID_TOPOLOGY', `Pressure boundary ${n.id} needs a positive absolute pressure`, `${p}.boundary.pressurePa`);
    }
    if (n.kind === 'mass_flow_source') {
      if (!n.boundary || n.boundary.massFlowKgS === undefined || !(n.boundary.massFlowKgS >= 0)) err('INVALID_TOPOLOGY', `Source ${n.id} needs a non-negative mass flow`, `${p}.boundary.massFlowKgS`);
    }
    if (n.boundary) {
      if (!(n.boundary.temperatureK > 0)) err('INVALID_SCHEMA', `Node ${n.id}: temperature must be in K (> 0)`, `${p}.boundary.temperatureK`);
      if (!(n.boundary.waterMassFraction >= 0 && n.boundary.waterMassFraction <= 1)) err('INVALID_SCHEMA', `Node ${n.id}: water mass fraction must be in [0,1]`, `${p}.boundary.waterMassFraction`);
    }
  });

  const pipeIds = new Map<string, (typeof cfg.links)[number]>();
  const nodeDevices = new Map<string, number>();
  const nodePipes = new Map<string, number>();
  cfg.links.forEach((l, i) => {
    const p = `links[${i}]`;
    dup(l.id, p);
    pipeIds.set(l.id, l);
    if (!nodes.has(l.fromNodeId)) err('INVALID_TOPOLOGY', `Link ${l.id}: unknown fromNodeId ${l.fromNodeId}`, `${p}.fromNodeId`);
    if (!nodes.has(l.toNodeId)) err('INVALID_TOPOLOGY', `Link ${l.id}: unknown toNodeId ${l.toNodeId}`, `${p}.toNodeId`);
    if (l.fromNodeId === l.toNodeId) err('INVALID_TOPOLOGY', `Link ${l.id} connects a node to itself`, p);
    if (l.kind === 'pipe') {
      nodePipes.set(l.fromNodeId, (nodePipes.get(l.fromNodeId) ?? 0) + 1);
      nodePipes.set(l.toNodeId, (nodePipes.get(l.toNodeId) ?? 0) + 1);
      if (!(l.lengthM > 0 && l.innerDiameterM > 0 && l.wallThicknessM > 0 && l.youngModulusPa > 0)) err('INVALID_SCHEMA', `Pipe ${l.id}: geometry and wall data must be positive`, p);
      if (!(l.roughnessM >= 0 && l.roughnessM < 0.05 * l.innerDiameterM)) err('INVALID_SCHEMA', `Pipe ${l.id}: roughness out of range`, `${p}.roughnessM`);
      if (!(l.poissonRatio > 0 && l.poissonRatio < 0.5)) err('INVALID_SCHEMA', `Pipe ${l.id}: Poisson ratio must be in (0, 0.5)`, `${p}.poissonRatio`);
      if (!fluids.has(l.fluidProfileId)) err('INVALID_TOPOLOGY', `Pipe ${l.id}: unknown fluid profile ${l.fluidProfileId}`, `${p}.fluidProfileId`);
      const ep = l.elevationProfile;
      if (ep.length < 2) err('INVALID_SCHEMA', `Pipe ${l.id}: elevation profile needs >= 2 points`, `${p}.elevationProfile`);
      else {
        if (Math.abs(ep[0]!.distanceM) > 1e-6 || Math.abs(ep[ep.length - 1]!.distanceM - l.lengthM) > 1e-6) err('INVALID_SCHEMA', `Pipe ${l.id}: elevation profile must span [0, length]`, `${p}.elevationProfile`);
        for (let k = 1; k < ep.length; k++) if (!(ep[k]!.distanceM > ep[k - 1]!.distanceM)) err('INVALID_SCHEMA', `Pipe ${l.id}: elevation profile distances must increase`, `${p}.elevationProfile`);
        const nf = nodes.get(l.fromNodeId);
        const nt = nodes.get(l.toNodeId);
        if (nf && Math.abs(nf.elevationM - ep[0]!.elevationM) > 0.05) err('INVALID_TOPOLOGY', `Pipe ${l.id}: start elevation differs from node ${nf.id}`, `${p}.elevationProfile`);
        if (nt && Math.abs(nt.elevationM - ep[ep.length - 1]!.elevationM) > 0.05) err('INVALID_TOPOLOGY', `Pipe ${l.id}: end elevation differs from node ${nt.id}`, `${p}.elevationProfile`);
      }
      if (!(l.thermal.overallHeatTransferWm2K >= 0 && l.thermal.referenceOuterDiameterM >= l.innerDiameterM)) err('INVALID_SCHEMA', `Pipe ${l.id}: thermal data inconsistent (U >= 0, D_o >= D)`, `${p}.thermal`);
      if (l.displayPolyline.length < 2) err('INVALID_SCHEMA', `Pipe ${l.id}: display polyline needs >= 2 points`, `${p}.displayPolyline`);
    } else {
      for (const nid of [l.fromNodeId, l.toNodeId]) nodeDevices.set(nid, (nodeDevices.get(nid) ?? 0) + 1);
      const nf = nodes.get(l.fromNodeId);
      const nt = nodes.get(l.toNodeId);
      if (nf && nt && Math.abs(nf.elevationM - nt.elevationM) > 0.5) warn('INVALID_TOPOLOGY', `Device ${l.id}: port elevations differ; hydrostatics inside devices is neglected`, p);
      if (l.kind === 'pump') {
        const q = l.curve.flowM3S;
        const h = l.curve.headM;
        if (q.length !== h.length || q.length < 3) err('INVALID_SCHEMA', `Pump ${l.id}: curve needs >= 3 points`, `${p}.curve`);
        for (let k = 1; k < h.length; k++) if (!(h[k]! < h[k - 1]! && q[k]! > q[k - 1]!)) err('INVALID_SCHEMA', `Pump ${l.id}: head must decrease with increasing flow`, `${p}.curve`);
        if (!(l.initialSpeedRatio >= 0 && l.initialSpeedRatio <= 1.2)) err('INVALID_SCHEMA', `Pump ${l.id}: speed ratio out of [0, 1.2]`, `${p}.initialSpeedRatio`);
      } else {
        const th = l.characteristic.opening;
        const K = l.characteristic.lossCoefficientK;
        if (th.length !== K.length || th.length < 2) err('INVALID_SCHEMA', `Valve ${l.id}: characteristic table mismatch`, `${p}.characteristic`);
        for (let k = 1; k < th.length; k++) if (!(th[k]! > th[k - 1]! && K[k]! <= K[k - 1]!)) err('INVALID_SCHEMA', `Valve ${l.id}: opening must increase and K must not increase`, `${p}.characteristic`);
        if (!(l.initialOpening >= 0 && l.initialOpening <= 1)) err('INVALID_SCHEMA', `Valve ${l.id}: opening out of [0,1]`, `${p}.initialOpening`);
        if (!(l.strokeTimeS >= 0)) err('INVALID_SCHEMA', `Valve ${l.id}: stroke time must be >= 0`, `${p}.strokeTimeS`);
      }
    }
  });
  for (const [nid, cnt] of nodeDevices) {
    const n = nodes.get(nid);
    if (!n) continue;
    if (cnt > 1) err('INVALID_TOPOLOGY', `Node ${nid} connects ${cnt} devices; put a pipe between devices`, 'links');
    if (n.kind === 'mass_flow_source' || n.kind === 'closed_end') err('INVALID_TOPOLOGY', `Device port ${nid} cannot be a ${n.kind}`, 'links');
    if (n.kind !== 'pressure_boundary' && !(nodePipes.get(nid)! > 0)) err('INVALID_TOPOLOGY', `Device port ${nid} needs at least one pipe or must be a pressure boundary`, 'links');
  }
  for (const n of cfg.nodes) {
    if ((nodePipes.get(n.id) ?? 0) + (nodeDevices.get(n.id) ?? 0) === 0) err('INVALID_TOPOLOGY', `Node ${n.id} is not connected`, 'nodes');
  }

  // connected components: each needs at least one pressure boundary (otherwise the pressure level of a
  // closed liquid volume is undetermined: a trapped volume needs its own dynamic state, not supported).
  const adj = new Map<string, string[]>();
  for (const l of cfg.links) {
    if (!nodes.has(l.fromNodeId) || !nodes.has(l.toNodeId)) continue;
    adj.set(l.fromNodeId, [...(adj.get(l.fromNodeId) ?? []), l.toNodeId]);
    adj.set(l.toNodeId, [...(adj.get(l.toNodeId) ?? []), l.fromNodeId]);
  }
  const seen = new Set<string>();
  for (const n of cfg.nodes) {
    if (seen.has(n.id)) continue;
    const comp: string[] = [];
    const stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      for (const nb of adj.get(c) ?? []) if (!seen.has(nb)) {
        seen.add(nb);
        stack.push(nb);
      }
    }
    if (!comp.some((id) => nodes.get(id)?.kind === 'pressure_boundary')) {
      err('INVALID_TOPOLOGY', `Component {${comp.join(', ')}} has no pressure boundary: isolated liquid volume is not supported`, 'nodes');
    }
  }

  // boundary composition within fluid bounds of attached pipes
  for (const n of cfg.nodes) {
    if (!n.boundary) continue;
    const attached = cfg.links.filter((l) => l.kind === 'pipe' && (l.fromNodeId === n.id || l.toNodeId === n.id));
    for (const l of attached) {
      if (l.kind !== 'pipe') continue;
      const f = fluids.get(l.fluidProfileId);
      if (!f) continue;
      const [tlo, thi] = f.validTemperatureK;
      if (n.boundary.temperatureK < tlo || n.boundary.temperatureK > thi) err('PROFILE_OUT_OF_RANGE', `Node ${n.id}: temperature outside profile ${f.id} range`, 'nodes');
      if (f.oil && f.water) {
        const [ylo, yhi] = f.compositionBounds.waterMassFraction;
        if (n.boundary.waterMassFraction < ylo || n.boundary.waterMassFraction > yhi) err('PROFILE_OUT_OF_RANGE', `Node ${n.id}: water fraction outside profile ${f.id} bounds`, 'nodes');
      }
      if (n.boundary.pressurePa !== undefined && n.boundary.pressurePa < f.phaseBoundaryModel.minPressurePa) err('UNSUPPORTED_PHASE_REGIME', `Node ${n.id}: boundary pressure below liquid-model limit of ${f.id}`, 'nodes');
    }
  }

  cfg.sensors.forEach((s, i) => {
    const p = `sensors[${i}]`;
    dup(s.id, p);
    if (s.nodeId) {
      if (!nodes.has(s.nodeId)) err('INVALID_TOPOLOGY', `Sensor ${s.id}: unknown node ${s.nodeId}`, `${p}.nodeId`);
    } else if (s.edgeId) {
      const l = pipeIds.get(s.edgeId);
      if (!l || l.kind !== 'pipe') err('INVALID_TOPOLOGY', `Sensor ${s.id}: edge ${s.edgeId} is not a pipe`, `${p}.edgeId`);
      else if (s.distanceM === undefined || s.distanceM < 0 || s.distanceM > l.lengthM) err('INVALID_TOPOLOGY', `Sensor ${s.id}: distance outside [0, L]`, `${p}.distanceM`);
    } else err('INVALID_TOPOLOGY', `Sensor ${s.id}: needs nodeId or edgeId+distanceM`, p);
    if (!(s.sampleRateHz > 0 && s.sampleRateHz <= 1000)) err('INVALID_SCHEMA', `Sensor ${s.id}: sample rate must be in (0, 1000] Hz`, `${p}.sampleRateHz`);
    if (!(s.noiseStdSI >= 0 && s.timeConstantS >= 0 && s.delayS >= 0 && s.timestampJitterS >= 0)) err('INVALID_SCHEMA', `Sensor ${s.id}: negative noise/time constants`, p);
    if (!(s.dropoutProbability >= 0 && s.dropoutProbability < 1)) err('INVALID_SCHEMA', `Sensor ${s.id}: dropout probability in [0,1)`, `${p}.dropoutProbability`);
    if (!(s.rangeSI[0] < s.rangeSI[1])) err('INVALID_SCHEMA', `Sensor ${s.id}: range must be increasing`, `${p}.rangeSI`);
    if (s.role === 'boundary_input') {
      if (!s.boundaryNodeId || !nodes.has(s.boundaryNodeId)) err('INVALID_TOPOLOGY', `Boundary-input sensor ${s.id} must name its boundary node`, `${p}.boundaryNodeId`);
    }
  });

  cfg.commands.forEach((c, i) => {
    const p = `commands[${i}]`;
    const target = c.kind === 'pump_speed' || c.kind === 'valve_opening' ? pipeIds.get(c.targetId) : undefined;
    if (c.kind === 'pump_speed' && target?.kind !== 'pump') err('INVALID_TOPOLOGY', `Command ${c.id}: ${c.targetId} is not a pump`, p);
    if (c.kind === 'valve_opening' && target?.kind !== 'valve') err('INVALID_TOPOLOGY', `Command ${c.id}: ${c.targetId} is not a valve`, p);
    if (c.kind === 'boundary_pressure' && nodes.get(c.targetId)?.kind !== 'pressure_boundary') err('INVALID_TOPOLOGY', `Command ${c.id}: ${c.targetId} is not a pressure boundary`, p);
    if (c.kind === 'source_mass_flow' && nodes.get(c.targetId)?.kind !== 'mass_flow_source') err('INVALID_TOPOLOGY', `Command ${c.id}: ${c.targetId} is not a source`, p);
    if (!(c.simTimeS >= 0)) err('INVALID_SCHEMA', `Command ${c.id}: negative time`, p);
  });

  const st = cfg.simulation;
  if (!(st.targetReachLengthM > 0 && st.minReachesPerPipe >= 2)) err('INVALID_SCHEMA', 'simulation: reach length > 0 and >= 2 reaches per pipe required', 'simulation');
  if (!(st.transportCourant > 0 && st.transportCourant <= 1)) err('INVALID_SCHEMA', 'simulation: transport Courant in (0,1]', 'simulation.transportCourant');
  if (!(st.durationS > 0)) err('INVALID_SCHEMA', 'simulation: duration must be positive', 'simulation.durationS');
  return { ok: errors.length === 0, errors, warnings };
}
