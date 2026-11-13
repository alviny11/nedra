import { ModelDomainError } from '@pipetwin/contracts';
import type { CompiledNetwork } from '../topology/compile';
import { pipeWaveSpeed, setReferenceProperties } from '../topology/compile';
import { solveHydraulics, type HydLink, type HydNode } from './hydraulics';
import { frictionTimesSpeed } from '../friction/friction';
import { valveLossCoefficient } from '../equipment/devices';
import { G } from '../units';

/** Boundary data at the initial instant (from setpoints for the generator, from measurements for observers). */
export interface BoundaryState {
  pressurePa: Float64Array; // per node (pressure nodes)
  massFlowKgS: Float64Array; // per node (sources)
  temperatureK: Float64Array; // per node (fluid entering the network)
  waterMassFraction: Float64Array; // per node
}

export interface SteadyInputs {
  boundary: BoundaryState;
  pumpSpeed: Float64Array;
  valveOpening: Float64Array;
  ambientK: Float64Array;
  /** 'fixed_all': cell viscosity stays at the value computed from the reference state */
  viscosityMode: 'transported' | 'fixed_reference';
  /** optional extra node withdrawals (diagnostic hypotheses) */
  nodeWithdrawalKgS?: Float64Array;
}

export interface SteadySolution {
  nodeP: Float64Array;
  pipeMassFlow: Float64Array;
  deviceMassFlow: Float64Array;
  closedCheckValves: boolean[];
  cellT: Float64Array;
  cellY: Float64Array;
  cellMu: Float64Array;
  nodeMixT: Float64Array;
  nodeMixY: Float64Array;
  pipeRef: Array<{ rho: number; c: number }>;
  deviceRho: Float64Array;
  pointP: Float64Array;
  pointU: Float64Array;
  outerIterations: number;
  maxLinkResidualPa: number;
  maxNodeResidualKgS: number;
}

interface ThermalResult {
  cellT: Float64Array;
  cellY: Float64Array;
  nodeMixT: Float64Array;
  nodeMixY: Float64Array;
}

/**
 * Steady temperature/composition for given link flows: exact exponential cooling per cell with
 * friction heating, enthalpy-weighted mixing at nodes, composition carried unchanged along pipes.
 */
export function steadyThermal(
  net: CompiledNetwork,
  pipeM: Float64Array,
  devM: Float64Array,
  boundary: BoundaryState,
  ambientK: Float64Array,
  cellMu: Float64Array,
  prevMixT?: Float64Array,
  prevMixY?: Float64Array
): ThermalResult {
  const nN = net.nodes.length;
  const mixT = new Float64Array(nN);
  const mixY = new Float64Array(nN);
  const known = new Uint8Array(nN);
  // reference for nodes without any inflow
  let refT = 0;
  let refY = 0;
  let cnt = 0;
  net.nodes.forEach((nd, i) => {
    if (nd.kind === 'pressure' || nd.kind === 'source') {
      refT += boundary.temperatureK[i]!;
      refY += boundary.waterMassFraction[i]!;
      cnt++;
    }
  });
  refT = cnt ? refT / cnt : 293.15;
  refY = cnt ? refY / cnt : 0;
  for (let i = 0; i < nN; i++) {
    mixT[i] = prevMixT?.[i] ?? refT;
    mixY[i] = prevMixY?.[i] ?? refY;
    const nd = net.nodes[i]!;
    if (nd.kind === 'pressure') {
      mixT[i] = boundary.temperatureK[i]!;
      mixY[i] = boundary.waterMassFraction[i]!;
      known[i] = 1;
    }
  }
  const cellT = new Float64Array(net.nCells);
  const cellY = new Float64Array(net.nCells);
  const outT = new Float64Array(net.pipes.length);
  const outY = new Float64Array(net.pipes.length);

  const marchPipe = (j: number): void => {
    const pp = net.pipes[j]!;
    const m = pipeM[j]!;
    const am = Math.abs(m);
    const inNode = m >= 0 ? pp.from : pp.to;
    const Tin = mixT[inNode]!;
    const Yin = mixY[inNode]!;
    const Tamb = ambientK[j]!;
    if (am < 1e-9) {
      for (let k = 0; k < pp.n; k++) {
        cellT[pp.cellOffset + k] = pp.U > 0 ? Tamb : Tin;
        cellY[pp.cellOffset + k] = Yin;
      }
      outT[j] = pp.U > 0 ? Tamb : Tin;
      outY[j] = Yin;
      return;
    }
    const u = m / (pp.rho * pp.A);
    let T = Tin;
    for (let s = 0; s < pp.n; s++) {
      const k = m >= 0 ? s : pp.n - 1 - s;
      const cp = pp.fluid.heatCapacity(Yin);
      const nu = cellMu[pp.cellOffset + k]! / pp.rho;
      const fU = frictionTimesSpeed(u, pp.D, nu, pp.relRough, net.settings.frictionModel) + (pp.localK * pp.D * Math.abs(u)) / pp.L;
      const qf = (fU * pp.rho * pp.A * u * u) / (2 * pp.D); // W/m friction dissipation
      const hl = pp.U * Math.PI * pp.Do; // W/(m K)
      const a = (hl * pp.dx) / (am * cp);
      let Tavg: number;
      let Tout: number;
      if (hl > 0) {
        const Teq = Tamb + qf / hl;
        const e = Math.exp(-a);
        Tout = Teq + (T - Teq) * e;
        Tavg = a > 1e-12 ? Teq + ((T - Teq) * (1 - e)) / a : 0.5 * (T + Tout);
      } else {
        Tout = T + (qf * pp.dx) / (am * cp);
        Tavg = 0.5 * (T + Tout);
      }
      cellT[pp.cellOffset + k] = Tavg;
      cellY[pp.cellOffset + k] = Yin;
      T = Tout;
    }
    outT[j] = T;
    outY[j] = Yin;
  };

  const maxPass = nN + net.pipes.length + 5;
  for (let pass = 0; pass < maxPass; pass++) {
    let maxChange = 0;
    for (let j = 0; j < net.pipes.length; j++) marchPipe(j);
    for (let i = 0; i < nN; i++) {
      const nd = net.nodes[i]!;
      if (nd.kind === 'pressure') continue;
      let msum = 0;
      let hsum = 0;
      let cpsum = 0;
      let ysum = 0;
      for (const e of nd.ends) {
        const pp = net.pipes[e.pipe]!;
        const m = pipeM[e.pipe]!;
        const inflow = e.end === 1 ? m : -m;
        if (inflow > 1e-12) {
          const cp = pp.fluid.heatCapacity(outY[e.pipe]!);
          msum += inflow;
          cpsum += inflow * cp;
          hsum += inflow * cp * outT[e.pipe]!;
          ysum += inflow * outY[e.pipe]!;
        }
      }
      for (const d of nd.devices) {
        const dev = net.devices[d.dev]!;
        const m = devM[d.dev]!;
        const inflow = d.side === 'to' ? m : -m;
        if (inflow > 1e-12) {
          const up = d.side === 'to' ? dev.from : dev.to;
          const fl = net.pipes[nd.ends[0]?.pipe ?? 0]?.fluid ?? net.pipes[0]!.fluid;
          const cp = fl.heatCapacity(mixY[up]!);
          msum += inflow;
          cpsum += inflow * cp;
          hsum += inflow * cp * mixT[up]!;
          ysum += inflow * mixY[up]!;
        }
      }
      if (nd.kind === 'source') {
        const inj = boundary.massFlowKgS[i]!;
        if (inj > 1e-12) {
          const fl = net.pipes[nd.ends[0]?.pipe ?? 0]!.fluid;
          const cp = fl.heatCapacity(boundary.waterMassFraction[i]!);
          msum += inj;
          cpsum += inj * cp;
          hsum += inj * cp * boundary.temperatureK[i]!;
          ysum += inj * boundary.waterMassFraction[i]!;
        }
      }
      if (msum > 1e-12) {
        const T = hsum / cpsum;
        const Y = ysum / msum;
        maxChange = Math.max(maxChange, Math.abs(T - mixT[i]!), Math.abs(Y - mixY[i]!));
        mixT[i] = T;
        mixY[i] = Y;
        known[i] = 1;
      }
    }
    if (maxChange < 1e-10 && pass > 0) break;
  }
  // nodes without any inflow (stagnant dead ends): take the state of the adjacent stagnant fluid
  for (let i = 0; i < nN; i++) {
    if (known[i]) continue;
    const e = net.nodes[i]!.ends[0];
    if (!e) continue;
    const pp = net.pipes[e.pipe]!;
    const c = e.end === 0 ? pp.cellOffset : pp.cellOffset + pp.n - 1;
    mixT[i] = cellT[c]!;
    mixY[i] = cellY[c]!;
  }
  return { cellT, cellY, nodeMixT: mixT, nodeMixY: mixY };
}

function computeCellMu(net: CompiledNetwork, cellT: Float64Array, cellY: Float64Array, nodeP?: Float64Array): Float64Array {
  const mu = new Float64Array(net.nCells);
  for (const pp of net.pipes) {
    const pm = nodeP ? 0.5 * (nodeP[pp.from]! + nodeP[pp.to]!) : pp.fluid.profile.referencePressurePa;
    for (let k = 0; k < pp.n; k++) {
      const c = pp.cellOffset + k;
      mu[c] = pp.fluid.viscosity(cellT[c]!, cellY[c]!, pm);
    }
  }
  return mu;
}

/**
 * Coupled steady state: hydraulics (Newton) <-> temperature/composition <-> viscosity and
 * per-pipe reference density, iterated to convergence. Sets the fixed reference rho/c per pipe
 * (M0 fixed-property acoustic mode) and the global time step on `net`.
 */
export function initializeSteadyState(net: CompiledNetwork, inputs: SteadyInputs): SteadySolution {
  const nN = net.nodes.length;
  const b = inputs.boundary;
  // initial guess of T/Y everywhere: mean boundary inflow state
  let T0 = 0;
  let Y0 = 0;
  let cnt = 0;
  net.nodes.forEach((nd, i) => {
    if (nd.kind === 'pressure' || nd.kind === 'source') {
      T0 += b.temperatureK[i]!;
      Y0 += b.waterMassFraction[i]!;
      cnt++;
    }
  });
  T0 = cnt ? T0 / cnt : 293.15;
  Y0 = cnt ? Y0 / cnt : 0;
  let cellT: Float64Array = new Float64Array(net.nCells).fill(T0);
  let cellY: Float64Array = new Float64Array(net.nCells).fill(Y0);
  for (const pp of net.pipes) {
    const yN = pp.fluid.normalizeYw(Y0);
    for (let k = 0; k < pp.n; k++) cellY[pp.cellOffset + k] = yN;
    const pr = pp.fluid.profile.referencePressurePa;
    pp.rho = pp.fluid.density(pr, T0, yN);
  }
  let cellMu: Float64Array = computeCellMu(net, cellT, cellY);
  const fixedMu = inputs.viscosityMode === 'fixed_reference' ? computeReferenceMu(net) : null;
  if (fixedMu) cellMu = fixedMu;
  const devRho = new Float64Array(net.devices.length);
  net.devices.forEach((d, i) => {
    const up = net.nodes[d.from]!;
    const pipe = net.pipes[up.ends[0]?.pipe ?? net.nodes[d.to]!.ends[0]!.pipe]!;
    devRho[i] = pipe.rho;
  });

  let hydInitM: Float64Array | undefined;
  let hydInitP: Float64Array | undefined;
  let nodeP: Float64Array = new Float64Array(nN);
  let pipeM: Float64Array = new Float64Array(net.pipes.length);
  let devM: Float64Array = new Float64Array(net.devices.length);
  let closed: boolean[] = [];
  let mixT: Float64Array | undefined;
  let mixY: Float64Array | undefined;
  let outer = 0;
  let maxLinkRes = 0;
  let maxNodeRes = 0;
  for (outer = 1; outer <= 40; outer++) {
    const nodes: HydNode[] = net.nodes.map((nd, i) => ({
      fixedPressurePa: nd.kind === 'pressure' ? b.pressurePa[i]! : undefined,
      injectionKgS: (nd.kind === 'source' ? b.massFlowKgS[i]! : 0) - (inputs.nodeWithdrawalKgS?.[i] ?? 0),
      elevationM: nd.z
    }));
    const links: HydLink[] = [];
    for (const pp of net.pipes) {
      links.push({
        kind: 'pipe',
        from: pp.from,
        to: pp.to,
        rho: pp.rho,
        A: pp.A,
        D: pp.D,
        relRough: pp.relRough,
        L: pp.L,
        localK: pp.localK,
        segLen: new Float64Array(pp.n).fill(pp.dx),
        segMu: cellMu.slice(pp.cellOffset, pp.cellOffset + pp.n),
        zFrom: net.zPt[pp.offset]!,
        zTo: net.zPt[pp.offset + pp.n]!,
        frictionModel: net.settings.frictionModel
      });
    }
    net.devices.forEach((d, i) => {
      if (d.kind === 'pump') {
        links.push({ kind: 'pump', from: d.from, to: d.to, rho: devRho[i]!, curve: d.curve!, speedRatio: inputs.pumpSpeed[i]!, checkValve: d.pump!.checkValve });
      } else {
        links.push({ kind: 'valve', from: d.from, to: d.to, rho: devRho[i]!, A: d.areaM2, K: valveLossCoefficient(d.valve!, inputs.valveOpening[i]!) });
      }
    });
    const res = solveHydraulics(nodes, links, { initialMassFlow: hydInitM, initialPressure: hydInitP });
    hydInitM = res.massFlow;
    hydInitP = res.pressure;
    maxLinkRes = res.maxLinkResidualPa;
    maxNodeRes = res.maxNodeResidualKgS;
    const newPipeM = res.massFlow.slice(0, net.pipes.length);
    const newDevM = res.massFlow.slice(net.pipes.length);
    closed = res.closedCheckValves.slice(net.pipes.length);
    nodeP = res.pressure;
    const th = steadyThermal(net, newPipeM, newDevM, b, inputs.ambientK, cellMu, mixT, mixY);
    let dT = 0;
    for (let c = 0; c < net.nCells; c++) dT = Math.max(dT, Math.abs(th.cellT[c]! - cellT[c]!), Math.abs(th.cellY[c]! - cellY[c]!));
    let dM = 0;
    for (let j = 0; j < net.pipes.length; j++) dM = Math.max(dM, Math.abs(newPipeM[j]! - pipeM[j]!) / Math.max(1, Math.abs(newPipeM[j]!)));
    cellT = th.cellT;
    cellY = th.cellY;
    mixT = th.nodeMixT;
    mixY = th.nodeMixY;
    pipeM = newPipeM;
    devM = newDevM;
    if (!fixedMu) cellMu = computeCellMu(net, cellT, cellY, nodeP);
    // per pipe reference density at mean state
    let dRho = 0;
    for (const pp of net.pipes) {
      const { Tm, Ym } = cellMeans(pp.cellOffset, pp.n, cellT, cellY);
      const pm = 0.5 * (nodeP[pp.from]! + nodeP[pp.to]!);
      const rhoNew = pp.fluid.density(pm, Tm, Ym);
      dRho = Math.max(dRho, Math.abs(rhoNew - pp.rho));
      pp.rho = rhoNew;
    }
    net.devices.forEach((d, i) => {
      const fl = net.pipes[net.nodes[d.from]!.ends[0]?.pipe ?? net.nodes[d.to]!.ends[0]!.pipe]!.fluid;
      devRho[i] = fl.density(nodeP[d.from]!, mixT![d.from]!, mixY![d.from]!);
    });
    if (outer > 1 && dT < 1e-7 && dM < 1e-10 && dRho < 1e-9) break;
  }
  if (outer > 40) throw new ModelDomainError('STEADY_STATE_NOT_FOUND', 'Thermal-hydraulic coupling did not converge');

  // reference acoustic properties (fixed for the run)
  const pipeRef = net.pipes.map((pp) => {
    const { Tm, Ym } = cellMeans(pp.cellOffset, pp.n, cellT, cellY);
    const pm = 0.5 * (nodeP[pp.from]! + nodeP[pp.to]!);
    return pipeWaveSpeed(pp, pm, Tm, Ym);
  });
  setReferenceProperties(net, pipeRef);
  net.devices.forEach((d, i) => {
    d.rho = devRho[i]!;
  });

  // pressure and velocity at grid points consistent with the cell-wise friction integration
  const pointP = new Float64Array(net.nPoints);
  const pointU = new Float64Array(net.nPoints);
  for (const pp of net.pipes) {
    const u = pipeM[pp.index]! / (pp.rho * pp.A);
    let pcur = nodeP[pp.from]!;
    pointP[pp.offset] = pcur;
    pointU[pp.offset] = u;
    for (let i = 1; i <= pp.n; i++) {
      const nu = cellMu[pp.cellOffset + i - 1]! / pp.rho;
      const fU = frictionTimesSpeed(u, pp.D, nu, pp.relRough, net.settings.frictionModel) + (pp.localK * pp.D * Math.abs(u)) / pp.L;
      pcur = pcur - pp.rho * G * (net.zPt[pp.offset + i]! - net.zPt[pp.offset + i - 1]!) - ((fU * pp.rho * u) / (2 * pp.D)) * pp.dx;
      pointP[pp.offset + i] = pcur;
      pointU[pp.offset + i] = u;
    }
  }
  return {
    nodeP,
    pipeMassFlow: pipeM,
    deviceMassFlow: devM,
    closedCheckValves: closed,
    cellT,
    cellY,
    cellMu,
    nodeMixT: mixT!,
    nodeMixY: mixY!,
    pipeRef,
    deviceRho: devRho,
    pointP,
    pointU,
    outerIterations: outer,
    maxLinkResidualPa: maxLinkRes,
    maxNodeResidualKgS: maxNodeRes
  };
}

function cellMeans(off: number, n: number, T: Float64Array, Y: Float64Array): { Tm: number; Ym: number } {
  let Tm = 0;
  let Ym = 0;
  for (let k = 0; k < n; k++) {
    Tm += T[off + k]!;
    Ym += Y[off + k]!;
  }
  return { Tm: Tm / n, Ym: Ym / n };
}

/** viscosity of every cell at the profile reference state (used by the fixed-property observer) */
export function computeReferenceMu(net: CompiledNetwork): Float64Array {
  const mu = new Float64Array(net.nCells);
  for (const pp of net.pipes) {
    const pr = pp.fluid.profile;
    const v = pp.fluid.viscosity(pr.referenceTemperatureK, pp.fluid.normalizeYw(pr.referenceWaterMassFraction), pr.referencePressurePa);
    for (let k = 0; k < pp.n; k++) mu[pp.cellOffset + k] = v;
  }
  return mu;
}
