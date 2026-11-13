import type { PublicCommand, PublicScenarioConfig } from '@pipetwin/contracts';
import { buildTopology, discretize, pipeWaveSpeed, type CompileOptions, type CompiledNetwork } from '../topology/compile';
import { initializeSteadyState, type BoundaryState, type SteadySolution } from '../steady/initialize';
import { TransientNetwork, type TransientOptions } from '../transient/network';

export interface Controls {
  boundary: BoundaryState;
  pumpSpeed: Float64Array;
  valveOpening: Float64Array;
  ambientK: Float64Array;
}

/** Boundary values and device settings from the public configuration (+ public commands at t <= t0). */
export function controlsFromConfig(config: PublicScenarioConfig, net: CompiledNetwork, t0 = 0): Controls {
  const nN = net.nodes.length;
  const boundary: BoundaryState = {
    pressurePa: new Float64Array(nN),
    massFlowKgS: new Float64Array(nN),
    temperatureK: new Float64Array(nN),
    waterMassFraction: new Float64Array(nN)
  };
  net.nodes.forEach((nd, i) => {
    const b = nd.cfg.boundary;
    if (b) {
      boundary.pressurePa[i] = b.pressurePa ?? 0;
      boundary.massFlowKgS[i] = b.massFlowKgS ?? 0;
      boundary.temperatureK[i] = b.temperatureK;
      boundary.waterMassFraction[i] = b.waterMassFraction;
    } else {
      boundary.temperatureK[i] = 293.15;
    }
  });
  const pumpSpeed = new Float64Array(net.devices.length);
  const valveOpening = new Float64Array(net.devices.length);
  net.devices.forEach((d, i) => {
    if (d.kind === 'pump') pumpSpeed[i] = d.pump!.initialSpeedRatio;
    else valveOpening[i] = d.valve!.initialOpening;
  });
  const ambientK = new Float64Array(net.pipes.map((p) => p.cfg.thermal.ambientTemperatureK));
  const initial = config.commands.filter((c) => c.simTimeS <= t0).sort((a, b) => a.simTimeS - b.simTimeS);
  for (const c of initial) applyCommandToControls(net, c, { boundary, pumpSpeed, valveOpening, ambientK });
  return { boundary, pumpSpeed, valveOpening, ambientK };
}

export function applyCommandToControls(net: CompiledNetwork, c: PublicCommand, ctl: Controls): void {
  switch (c.kind) {
    case 'pump_speed': {
      const d = net.deviceIndex.get(c.targetId);
      if (d !== undefined) ctl.pumpSpeed[d] = c.speedRatio;
      break;
    }
    case 'valve_opening': {
      const d = net.deviceIndex.get(c.targetId);
      if (d !== undefined) ctl.valveOpening[d] = c.opening;
      break;
    }
    case 'boundary_pressure': {
      const n = net.nodeIndex.get(c.targetId);
      if (n !== undefined) ctl.boundary.pressurePa[n] = c.pressurePa;
      break;
    }
    case 'source_mass_flow': {
      const n = net.nodeIndex.get(c.targetId);
      if (n !== undefined) ctl.boundary.massFlowKgS[n] = c.massFlowKgS;
      break;
    }
  }
}

export interface BuiltModel {
  net: CompiledNetwork;
  steady: SteadySolution;
  model: TransientNetwork;
}

export interface BuildOptions extends CompileOptions {
  viscosityMode: 'transported' | 'fixed_reference';
  transport: boolean;
  checkPhaseBoundary?: boolean;
  /** compute controls from a compiled network (allows observers to inject measured boundary values) */
  controls?: (net: CompiledNetwork) => Controls;
}

/** compile -> discretise -> coupled steady state -> transient MOC model */
export function buildTransientModel(config: PublicScenarioConfig, opts: BuildOptions): BuiltModel {
  const net = buildTopology(config, opts);
  discretize(
    net,
    (pp) => {
      const pr = pp.fluid.profile;
      return pipeWaveSpeed(pp, pr.referencePressurePa, pr.referenceTemperatureK, pp.fluid.normalizeYw(pr.referenceWaterMassFraction)).c;
    },
    opts
  );
  const controls = opts.controls ? opts.controls(net) : controlsFromConfig(config, net);
  const steady = initializeSteadyState(net, {
    boundary: controls.boundary,
    pumpSpeed: controls.pumpSpeed,
    valveOpening: controls.valveOpening,
    ambientK: controls.ambientK,
    viscosityMode: opts.viscosityMode === 'fixed_reference' ? 'fixed_reference' : 'transported'
  });
  const tOpts: Partial<TransientOptions> = {
    viscosityMode: opts.viscosityMode,
    transport: opts.transport,
    checkPhaseBoundary: opts.checkPhaseBoundary ?? true
  };
  const model = new TransientNetwork(net, steady, controls, tOpts);
  return { net, steady, model };
}
