import type { CompiledNetwork } from '../topology/compile';
import type { TransientNetwork } from './network';

/** Static description of the solver grid, sent once to UIs. */
export interface GridLayout {
  pipeIds: string[];
  pipeOffsets: number[];
  pipeReaches: number[];
  pipeDx: number[];
  pipeLength: number[];
  pipeRho: number[];
  pipeWaveSpeed: number[];
  pipeCourant: number[];
  nodeIds: string[];
  deviceIds: string[];
  nPoints: number;
  dt: number;
}

export interface FieldSnapshot {
  simTimeS: number;
  /** pressure at grid points [Pa abs] */
  p: Float64Array;
  /** mass flow at grid points (right side) [kg/s] */
  m: Float64Array;
  /** temperature and water mass fraction interpolated to grid points */
  T: Float64Array;
  Y: Float64Array;
  nodeP: Float64Array;
  deviceMassFlow: Float64Array;
  pumpSpeed: Float64Array;
  valveOpening: Float64Array;
}

export function gridLayout(net: CompiledNetwork): GridLayout {
  return {
    pipeIds: net.pipes.map((p) => p.id),
    pipeOffsets: net.pipes.map((p) => p.offset),
    pipeReaches: net.pipes.map((p) => p.n),
    pipeDx: net.pipes.map((p) => p.dx),
    pipeLength: net.pipes.map((p) => p.L),
    pipeRho: net.pipes.map((p) => p.rho),
    pipeWaveSpeed: net.pipes.map((p) => p.c),
    pipeCourant: net.pipes.map((p) => p.courant),
    nodeIds: net.nodes.map((n) => n.id),
    deviceIds: net.devices.map((d) => d.id),
    nPoints: net.nPoints,
    dt: net.dt
  };
}

export function fieldSnapshot(model: TransientNetwork): FieldSnapshot {
  const net = model.net;
  const m = new Float64Array(net.nPoints);
  const T = new Float64Array(net.nPoints);
  const Y = new Float64Array(net.nPoints);
  for (const pp of net.pipes) {
    for (let i = 0; i <= pp.n; i++) {
      const g = pp.offset + i;
      m[g] = pp.rho * pp.A * model.uR[g]!;
      const kL = Math.max(0, i - 1);
      const kR = Math.min(pp.n - 1, i);
      T[g] = 0.5 * (model.cellT[pp.cellOffset + kL]! + model.cellT[pp.cellOffset + kR]!);
      Y[g] = 0.5 * (model.cellY[pp.cellOffset + kL]! + model.cellY[pp.cellOffset + kR]!);
    }
  }
  return {
    simTimeS: model.t,
    p: model.p.slice(),
    m,
    T,
    Y,
    nodeP: model.nodeP.slice(),
    deviceMassFlow: model.devM.slice(),
    pumpSpeed: model.pumpSpeed.slice(),
    valveOpening: model.valveOpening.slice()
  };
}
