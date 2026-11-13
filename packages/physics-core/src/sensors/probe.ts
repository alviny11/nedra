import type { SensorConfig, SensorKind } from '@pipetwin/contracts';
import { ModelDomainError } from '@pipetwin/contracts';
import type { CompiledNetwork } from '../topology/compile';
import type { TransientNetwork } from '../transient/network';

/** Where and what a sensor senses on the solver grid. Interpolates the computed field, never truth metadata. */
export interface SensorProbe {
  sensorId: string;
  kind: SensorKind;
  node?: number;
  pipe?: number;
  /** grid points bracketing the position, and weight toward b */
  a?: number;
  b?: number;
  w?: number;
  /** cells bracketing the position (cell-centre interpolation) and weight */
  ca?: number;
  cb?: number;
  cw?: number;
}

export function compileProbe(net: CompiledNetwork, s: SensorConfig): SensorProbe {
  if (s.nodeId) {
    const node = net.nodeIndex.get(s.nodeId);
    if (node === undefined) throw new ModelDomainError('INVALID_TOPOLOGY', `Sensor ${s.id}: unknown node ${s.nodeId}`);
    if (s.kind !== 'pressure') {
      // flows/temperatures at a node are ambiguous: map to the first attached pipe end
      const nd = net.nodes[node]!;
      const e = nd.ends[0];
      if (!e) throw new ModelDomainError('INVALID_TOPOLOGY', `Sensor ${s.id}: node ${s.nodeId} has no pipe for a ${s.kind} reading`);
      const pp = net.pipes[e.pipe]!;
      return compileEdgeProbe(net, s, pp.index, e.end === 0 ? 0 : pp.L);
    }
    return { sensorId: s.id, kind: s.kind, node };
  }
  const pipe = s.edgeId ? net.pipeIndex.get(s.edgeId) : undefined;
  if (pipe === undefined) throw new ModelDomainError('INVALID_TOPOLOGY', `Sensor ${s.id}: unknown or non-pipe edge ${s.edgeId}`);
  return compileEdgeProbe(net, s, pipe, s.distanceM ?? 0);
}

function compileEdgeProbe(net: CompiledNetwork, s: SensorConfig, pipe: number, distanceM: number): SensorProbe {
  const pp = net.pipes[pipe]!;
  const x = Math.min(Math.max(distanceM, 0), pp.L);
  const fa = Math.min(pp.n - 1, Math.floor(x / pp.dx));
  const w = (x - fa * pp.dx) / pp.dx;
  // cell centres at (k+0.5) dx
  const xc = x / pp.dx - 0.5;
  let ca = Math.floor(xc);
  let cw = xc - ca;
  if (ca < 0) {
    ca = 0;
    cw = 0;
  }
  if (ca >= pp.n - 1) {
    ca = pp.n - 1;
    cw = 0;
  }
  const cb = Math.min(pp.n - 1, ca + 1);
  return {
    sensorId: s.id,
    kind: s.kind,
    pipe,
    a: pp.offset + fa,
    b: pp.offset + fa + 1,
    w,
    ca: pp.cellOffset + ca,
    cb: pp.cellOffset + cb,
    cw
  };
}

/** Value of the sensed physical quantity h_i(U) in SI for the current solver state. */
export function evaluateProbe(model: TransientNetwork, pr: SensorProbe): number {
  const net = model.net;
  if (pr.node !== undefined) return model.nodeP[pr.node]!;
  const pp = net.pipes[pr.pipe!]!;
  const a = pr.a!;
  const b = pr.b!;
  const w = pr.w!;
  switch (pr.kind) {
    case 'pressure':
      return (1 - w) * model.p[a]! + w * model.p[b]!;
    case 'massFlow': {
      const u = (1 - w) * model.uR[a]! + w * model.uL[b]!;
      return pp.rho * pp.A * u;
    }
    case 'volumeFlow': {
      const u = (1 - w) * model.uR[a]! + w * model.uL[b]!;
      return pp.A * u;
    }
    case 'temperature':
      return (1 - pr.cw!) * model.cellT[pr.ca!]! + pr.cw! * model.cellT[pr.cb!]!;
    case 'waterFraction': {
      const Y = (1 - pr.cw!) * model.cellY[pr.ca!]! + pr.cw! * model.cellY[pr.cb!]!;
      const T = (1 - pr.cw!) * model.cellT[pr.ca!]! + pr.cw! * model.cellT[pr.cb!]!;
      const p = (1 - w) * model.p[a]! + w * model.p[b]!;
      return pp.fluid.waterVolumeFraction(Y, p, T);
    }
  }
}
