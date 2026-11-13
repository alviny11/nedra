import type {
  NodeConfig,
  PipeConfig,
  PublicScenarioConfig,
  PumpConfig,
  SimulationSettings,
  ValveConfig
} from '@pipetwin/contracts';
import { ModelDomainError } from '@pipetwin/contracts';
import { FluidModel, effectiveWaveSpeed, restraintFactor, type FluidDeviation } from '../fluids/fluidModel';
import { fitPumpCurve, type PumpCurve } from '../equipment/devices';
import { profileAt } from '../numerics/interp';

export type CompiledNodeKind = 'junction' | 'pressure' | 'source' | 'closed';

export interface CompiledNode {
  index: number;
  id: string;
  cfg: NodeConfig;
  kind: CompiledNodeKind;
  z: number;
  /** pipe ends attached: end 0 = pipe start (x=0), end 1 = pipe end (x=L) */
  ends: Array<{ pipe: number; end: 0 | 1 }>;
  devices: Array<{ dev: number; side: 'from' | 'to' }>;
}

export interface CompiledPipe {
  index: number;
  id: string;
  cfg: PipeConfig;
  from: number;
  to: number;
  L: number;
  D: number;
  A: number;
  relRough: number;
  localK: number;
  /** chi D / (E e): wall compliance contribution [1/Pa] */
  wallCompliance: number;
  Do: number;
  U: number;
  ambientK: number;
  fluid: FluidModel;
  // discretisation (filled by discretize)
  n: number;
  dx: number;
  offset: number;
  cellOffset: number;
  // fixed reference properties for the acoustic model (filled by setReferenceProperties)
  rho: number;
  c: number;
  Z: number;
  courant: number;
}

export interface CompiledDevice {
  index: number;
  id: string;
  kind: 'pump' | 'valve';
  pump?: PumpConfig;
  valve?: ValveConfig;
  from: number;
  to: number;
  curve?: PumpCurve;
  areaM2: number;
  /** fixed reference density of the fluid passing the device */
  rho: number;
}

export interface CompiledNetwork {
  config: PublicScenarioConfig;
  settings: SimulationSettings;
  nodes: CompiledNode[];
  pipes: CompiledPipe[];
  devices: CompiledDevice[];
  nodeIndex: Map<string, number>;
  pipeIndex: Map<string, number>;
  deviceIndex: Map<string, number>;
  fluids: Map<string, FluidModel>;
  nPoints: number;
  nCells: number;
  dt: number;
  /** elevation at grid points */
  zPt: Float64Array;
  /** position along its own pipe for each grid point */
  xPt: Float64Array;
  pipeOfPoint: Int32Array;
}

export interface CompileOptions {
  fluidDeviation?: FluidDeviation;
  roughnessFactor?: number;
  /** override of the target reach length (mesh studies) */
  targetReachLengthM?: number;
}

const NODE_KIND: Record<NodeConfig['kind'], CompiledNodeKind> = {
  junction: 'junction',
  pressure_boundary: 'pressure',
  mass_flow_source: 'source',
  closed_end: 'closed'
};

export function buildTopology(config: PublicScenarioConfig, opts: CompileOptions = {}): CompiledNetwork {
  const fluids = new Map<string, FluidModel>();
  for (const fp of config.fluidProfiles) fluids.set(fp.id, new FluidModel(fp, opts.fluidDeviation ?? {}));
  const nodeIndex = new Map<string, number>();
  const nodes: CompiledNode[] = config.nodes.map((n, i) => {
    nodeIndex.set(n.id, i);
    return { index: i, id: n.id, cfg: n, kind: NODE_KIND[n.kind], z: n.elevationM, ends: [], devices: [] };
  });
  const pipeIndex = new Map<string, number>();
  const deviceIndex = new Map<string, number>();
  const pipes: CompiledPipe[] = [];
  const devices: CompiledDevice[] = [];
  const nodeOf = (id: string, linkId: string): number => {
    const k = nodeIndex.get(id);
    if (k === undefined) throw new ModelDomainError('INVALID_TOPOLOGY', `Link ${linkId} references unknown node ${id}`);
    return k;
  };
  for (const link of config.links) {
    if (link.kind === 'pipe') {
      const fluid = fluids.get(link.fluidProfileId);
      if (!fluid) throw new ModelDomainError('INVALID_TOPOLOGY', `Pipe ${link.id} references unknown fluid ${link.fluidProfileId}`);
      const idx = pipes.length;
      const from = nodeOf(link.fromNodeId, link.id);
      const to = nodeOf(link.toNodeId, link.id);
      const D = link.innerDiameterM;
      const chi = restraintFactor(link.restraintModel, link.poissonRatio);
      pipes.push({
        index: idx,
        id: link.id,
        cfg: link,
        from,
        to,
        L: link.lengthM,
        D,
        A: (Math.PI * D * D) / 4,
        relRough: (link.roughnessM * (opts.roughnessFactor ?? 1)) / D,
        localK: link.localLossK ?? 0,
        wallCompliance: (chi * D) / (link.youngModulusPa * link.wallThicknessM),
        Do: link.thermal.referenceOuterDiameterM,
        U: link.thermal.overallHeatTransferWm2K,
        ambientK: link.thermal.ambientTemperatureK,
        fluid,
        n: 0,
        dx: 0,
        offset: 0,
        cellOffset: 0,
        rho: 0,
        c: 0,
        Z: 0,
        courant: 0
      });
      pipeIndex.set(link.id, idx);
      nodes[from]!.ends.push({ pipe: idx, end: 0 });
      nodes[to]!.ends.push({ pipe: idx, end: 1 });
    } else {
      const idx = devices.length;
      const from = nodeOf(link.fromNodeId, link.id);
      const to = nodeOf(link.toNodeId, link.id);
      const dev: CompiledDevice = {
        index: idx,
        id: link.id,
        kind: link.kind,
        from,
        to,
        areaM2: link.kind === 'valve' ? (Math.PI * link.diameterM * link.diameterM) / 4 : 0,
        rho: 0
      };
      if (link.kind === 'pump') {
        dev.pump = link;
        dev.curve = fitPumpCurve(link);
      } else {
        dev.valve = link as ValveConfig;
      }
      devices.push(dev);
      deviceIndex.set(link.id, idx);
      nodes[from]!.devices.push({ dev: idx, side: 'from' });
      nodes[to]!.devices.push({ dev: idx, side: 'to' });
    }
  }
  return {
    config,
    settings: config.simulation,
    nodes,
    pipes,
    devices,
    nodeIndex,
    pipeIndex,
    deviceIndex,
    fluids,
    nPoints: 0,
    nCells: 0,
    dt: 0,
    zPt: new Float64Array(0),
    xPt: new Float64Array(0),
    pipeOfPoint: new Int32Array(0)
  };
}

/** reference wave speed of a pipe for given liquid state (elastic wall included) */
export function pipeWaveSpeed(pipe: CompiledPipe, p: number, T: number, yw: number): { rho: number; c: number } {
  const rho = pipe.fluid.density(p, T, yw);
  const K = pipe.fluid.bulkModulus(p, T, yw);
  const chi = restraintFactor(pipe.cfg.restraintModel, pipe.cfg.poissonRatio);
  const c = effectiveWaveSpeed(rho, K, pipe.D, pipe.cfg.wallThicknessM, pipe.cfg.youngModulusPa, chi);
  return { rho, c };
}

/**
 * Choose reach counts from a target reach length using the boundary state of the network as a
 * first estimate of c. The grid (n per pipe) is then fixed; dt is recomputed later from final c.
 */
export function discretize(net: CompiledNetwork, cEstimate: (pipe: CompiledPipe) => number, opts: CompileOptions = {}): void {
  const target = opts.targetReachLengthM ?? net.settings.targetReachLengthM;
  const minN = Math.max(2, net.settings.minReachesPerPipe);
  // dt from the most restrictive pipe at its target reach count
  let dt = Number.POSITIVE_INFINITY;
  for (const p of net.pipes) {
    const nT = Math.max(minN, Math.round(p.L / target));
    dt = Math.min(dt, p.L / (nT * cEstimate(p)));
  }
  let offset = 0;
  let cellOffset = 0;
  for (const p of net.pipes) {
    const n = Math.max(minN, Math.floor((p.L / (cEstimate(p) * dt)) * (1 + 1e-12)));
    p.n = n;
    p.dx = p.L / n;
    p.offset = offset;
    p.cellOffset = cellOffset;
    offset += n + 1;
    cellOffset += n;
  }
  net.nPoints = offset;
  net.nCells = cellOffset;
  net.zPt = new Float64Array(offset);
  net.xPt = new Float64Array(offset);
  net.pipeOfPoint = new Int32Array(offset);
  for (const p of net.pipes) {
    for (let i = 0; i <= p.n; i++) {
      const x = i * p.dx;
      net.zPt[p.offset + i] = profileAt(p.cfg.elevationProfile, x);
      net.xPt[p.offset + i] = x;
      net.pipeOfPoint[p.offset + i] = p.index;
    }
  }
  net.dt = dt;
}

/**
 * Fix reference rho/c per pipe (M0 fixed-property acoustic mode) and recompute the global time
 * step so that every pipe has Courant number c dt / dx <= 1 (space-line interpolation otherwise).
 */
export function setReferenceProperties(net: CompiledNetwork, props: Array<{ rho: number; c: number }>): void {
  let dt = Number.POSITIVE_INFINITY;
  net.pipes.forEach((p, i) => {
    const pr = props[i]!;
    p.rho = pr.rho;
    p.c = pr.c;
    p.Z = pr.rho * pr.c;
    dt = Math.min(dt, p.dx / p.c);
  });
  net.dt = dt;
  for (const p of net.pipes) p.courant = (p.c * dt) / p.dx;
}
