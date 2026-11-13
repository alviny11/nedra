import { ModelDomainError } from '@pipetwin/contracts';
import { frictionTimesSpeed, type FrictionModel } from '../friction/friction';
import { pumpHead, pumpHeadDerivative, type PumpCurve } from '../equipment/devices';
import { solveDense } from '../numerics/solve';
import { G } from '../units';

/**
 * Generic steady hydraulic network solved by damped Newton on link mass flows and free node pressures
 * (equivalent in structure to the EPANET global gradient formulation).
 */
export interface HydNode {
  fixedPressurePa?: number;
  /** external mass injection into the node [kg/s] (negative = withdrawal) */
  injectionKgS: number;
  elevationM: number;
  /** optional pressure-dependent orifice withdrawal (liquid) */
  orifice?: { cd: number; areaM2: number; rho: number; pExtPa: number };
}

export type HydLink =
  | {
      kind: 'pipe';
      from: number;
      to: number;
      rho: number;
      A: number;
      D: number;
      relRough: number;
      L: number;
      localK: number;
      /** segment lengths and dynamic viscosities (cells) */
      segLen: Float64Array;
      segMu: Float64Array;
      zFrom: number;
      zTo: number;
      frictionModel: FrictionModel;
    }
  | { kind: 'pump'; from: number; to: number; rho: number; curve: PumpCurve; speedRatio: number; checkValve: boolean }
  | { kind: 'valve'; from: number; to: number; rho: number; A: number; K: number };

export interface HydResult {
  massFlow: Float64Array;
  pressure: Float64Array;
  iterations: number;
  maxLinkResidualPa: number;
  maxNodeResidualKgS: number;
  closedCheckValves: boolean[];
}

export interface HydOptions {
  maxIter?: number;
  tolPa?: number;
  tolKgS?: number;
  initialMassFlow?: Float64Array;
  initialPressure?: Float64Array;
}

const P_SCALE = 1e5;
const M_SCALE = 1;
const VALVE_EPS = 1e-6;

/** frictional + local pressure drop of a pipe (signed, along from->to) and its derivative w.r.t. m */
export function pipeLoss(link: Extract<HydLink, { kind: 'pipe' }>, m: number): [number, number] {
  const f = (mm: number): number => {
    const u = mm / (link.rho * link.A);
    let s = 0;
    for (let k = 0; k < link.segLen.length; k++) {
      const nu = link.segMu[k]! / link.rho;
      s += ((frictionTimesSpeed(u, link.D, nu, link.relRough, link.frictionModel) * link.rho * u) / (2 * link.D)) * link.segLen[k]!;
    }
    s += (link.localK * link.rho * u * Math.abs(u)) / 2;
    return s;
  };
  const v = f(m);
  const h = Math.max(1e-7 * Math.abs(m), 1e-9);
  const d = (f(m + h) - f(m - h)) / (2 * h);
  return [v, d];
}

export function solveHydraulics(nodes: HydNode[], links: HydLink[], opts: HydOptions = {}): HydResult {
  const nL = links.length;
  const freePos = new Int32Array(nodes.length).fill(-1);
  let nF = 0;
  nodes.forEach((n, i) => {
    if (n.fixedPressurePa === undefined) freePos[i] = nF++;
  });
  const N = nL + nF;
  const m = new Float64Array(nL);
  const p = new Float64Array(nodes.length);
  const fixedPs = nodes.filter((n) => n.fixedPressurePa !== undefined).map((n) => n.fixedPressurePa!);
  const pMean = fixedPs.length ? fixedPs.reduce((a, b) => a + b, 0) / fixedPs.length : 5e5;
  nodes.forEach((n, i) => {
    p[i] = n.fixedPressurePa ?? opts.initialPressure?.[i] ?? pMean;
  });
  const totalInj = nodes.reduce((s, n) => s + Math.abs(n.injectionKgS), 0);
  for (let l = 0; l < nL; l++) m[l] = opts.initialMassFlow?.[l] ?? Math.max(1, 0.5 * totalInj);
  const closed: boolean[] = links.map(() => false);
  const maxIter = opts.maxIter ?? 200;
  const tolPa = opts.tolPa ?? 1e-3;
  const tolKg = opts.tolKgS ?? 1e-9;

  const R = new Float64Array(N);
  const J = new Float64Array(N * N);

  const linkClosed = (l: number): boolean => {
    const lk = links[l]!;
    if (lk.kind === 'valve') return !(lk.K < Number.POSITIVE_INFINITY);
    if (lk.kind === 'pump') return closed[l]!;
    return false;
  };

  const assemble = (mm: Float64Array, pp: Float64Array, withJ: boolean): number => {
    if (withJ) J.fill(0);
    let norm = 0;
    for (let l = 0; l < nL; l++) {
      const lk = links[l]!;
      const pf = pp[lk.from]!;
      const pt = pp[lk.to]!;
      let r: number;
      let dm: number;
      let dpf = 1;
      let dpt = -1;
      if (linkClosed(l)) {
        r = (mm[l]! / M_SCALE) * P_SCALE;
        dm = P_SCALE / M_SCALE;
        dpf = 0;
        dpt = 0;
      } else if (lk.kind === 'pipe') {
        const [loss, dloss] = pipeLoss(lk, mm[l]!);
        r = pf - pt - lk.rho * G * (lk.zTo - lk.zFrom) - loss;
        dm = -dloss;
      } else if (lk.kind === 'pump') {
        const q = mm[l]! / lk.rho;
        r = pf - pt + lk.rho * G * pumpHead(lk.curve, q, lk.speedRatio);
        dm = G * pumpHeadDerivative(lk.curve, q, lk.speedRatio);
      } else {
        const mv = mm[l]!;
        const s = Math.sqrt(mv * mv + VALVE_EPS * VALVE_EPS);
        const c = lk.K / (2 * lk.rho * lk.A * lk.A);
        r = pf - pt - c * mv * s;
        dm = -c * (s + (mv * mv) / s);
      }
      R[l] = r / P_SCALE;
      norm += R[l]! * R[l]!;
      if (withJ) {
        J[l * N + l] = dm / P_SCALE;
        const ff = freePos[lk.from]!;
        const ft = freePos[lk.to]!;
        if (ff >= 0) J[l * N + nL + ff] = dpf / P_SCALE;
        if (ft >= 0) J[l * N + nL + ft] = dpt / P_SCALE;
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      const fi = freePos[i]!;
      if (fi < 0) continue;
      const row = nL + fi;
      const nd = nodes[i]!;
      let r = nd.injectionKgS;
      let dp = 0;
      if (nd.orifice) {
        const o = nd.orifice;
        const dpo = pp[i]! - o.pExtPa;
        if (dpo > 0) {
          const w = o.cd * o.areaM2 * Math.sqrt(2 * o.rho * dpo);
          r -= w;
          dp = -(o.cd * o.areaM2 * o.rho) / Math.sqrt(2 * o.rho * dpo);
        } else {
          dp = -o.cd * o.areaM2 * 1e-3; // keep Jacobian regular; residual decides
        }
      }
      R[row] = r; // filled below with link flows
      if (withJ) J[row * N + nL + fi] = dp / M_SCALE;
    }
    for (let l = 0; l < nL; l++) {
      const lk = links[l]!;
      const ff = freePos[lk.from]!;
      const ft = freePos[lk.to]!;
      if (ff >= 0) {
        R[nL + ff]! -= mm[l]!;
        if (withJ) J[(nL + ff) * N + l] = -1 / M_SCALE;
      }
      if (ft >= 0) {
        R[nL + ft]! += mm[l]!;
        if (withJ) J[(nL + ft) * N + l] = 1 / M_SCALE;
      }
    }
    for (let k = nL; k < N; k++) {
      R[k] = R[k]! / M_SCALE;
      norm += R[k]! * R[k]!;
    }
    return Math.sqrt(norm);
  };

  const converged = (): boolean => {
    for (let l = 0; l < nL; l++) if (Math.abs(R[l]!) * P_SCALE > tolPa) return false;
    for (let k = nL; k < N; k++) if (Math.abs(R[k]!) * M_SCALE > tolKg) return false;
    return true;
  };

  let iterations = 0;
  for (let round = 0; round < 6; round++) {
    let ok = false;
    for (let it = 0; it < maxIter; it++) {
      iterations++;
      const norm0 = assemble(m, p, true);
      if (converged()) {
        ok = true;
        break;
      }
      const rhs = new Float64Array(N);
      for (let k = 0; k < N; k++) rhs[k] = -R[k]!;
      const dx = solveDense(J.slice(), rhs, N);
      if (!dx) throw new ModelDomainError('STEADY_STATE_NOT_FOUND', 'Singular Jacobian in steady hydraulic solve (isolated volume or ill-posed boundaries?)');
      let alpha = 1;
      const m1 = new Float64Array(nL);
      const p1 = new Float64Array(p);
      for (let ls = 0; ls < 40; ls++) {
        for (let l = 0; l < nL; l++) m1[l] = m[l]! + alpha * dx[l]!;
        for (let i = 0; i < nodes.length; i++) {
          const fi = freePos[i]!;
          if (fi >= 0) p1[i] = p[i]! + alpha * dx[nL + fi]!;
        }
        const norm1 = assemble(m1, p1, false);
        if (Number.isFinite(norm1) && norm1 <= (1 - 1e-4 * alpha) * norm0) break;
        alpha *= 0.5;
      }
      m.set(m1);
      p.set(p1);
    }
    if (!ok) {
      throw new ModelDomainError('STEADY_STATE_NOT_FOUND', 'Steady hydraulic Newton did not converge', { iterations });
    }
    // check-valve active set
    let changed = false;
    links.forEach((lk, l) => {
      if (lk.kind !== 'pump' || !lk.checkValve) return;
      if (!closed[l] && m[l]! < -1e-9) {
        closed[l] = true;
        m[l] = 0;
        changed = true;
      } else if (closed[l]) {
        const drive = p[lk.from]! - p[lk.to]! + lk.rho * G * pumpHead(lk.curve, 0, lk.speedRatio);
        if (drive > 1e-6) {
          closed[l] = false;
          m[l] = 1e-3;
          changed = true;
        }
      }
    });
    if (!changed) break;
  }
  assemble(m, p, false);
  let maxLink = 0;
  let maxNode = 0;
  for (let l = 0; l < nL; l++) maxLink = Math.max(maxLink, Math.abs(R[l]!) * P_SCALE);
  for (let k = nL; k < N; k++) maxNode = Math.max(maxNode, Math.abs(R[k]!) * M_SCALE);
  return { massFlow: m, pressure: p, iterations, maxLinkResidualPa: maxLink, maxNodeResidualKgS: maxNode, closedCheckValves: closed };
}
