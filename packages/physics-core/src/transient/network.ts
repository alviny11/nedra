import { ModelDomainError } from '@pipetwin/contracts';
import type { CompiledNetwork } from '../topology/compile';
import type { SteadySolution } from '../steady/initialize';
import { frictionFactor, frictionTimesSpeed, RE_LAMINAR_MAX } from '../friction/friction';
import { firstOrderActuator, pumpHead, pumpHeadDerivative, rateLimitedStroke, valveLossCoefficient } from '../equipment/devices';
import { solveMonotone } from '../numerics/solve';
import { G } from '../units';

/**
 * M0 liquid transient network solver.
 *
 * Hydraulics: method of characteristics on a fixed grid (space-line interpolation for Courant < 1),
 *   p_t + rho c^2 u_x = 0,  u_t + p_x/rho = -g z_x - f u|u|/(2D)
 *   with fixed reference rho and c per pipe (M0 "fixed-property acoustic" mode), quasi-steady
 *   friction evaluated semi-implicitly (u_P |u_foot|), local viscosity from transported T and Y_w.
 * Nodes: mass balance with incoming characteristics; pumps/valves add a pressure jump between two ports.
 * Leaks: hidden interior orifice points with two velocities (left/right) solved jointly with both
 *   characteristics; outflow from the local pressure at every step.
 * Transport: conservative finite volume for mass, water mass and enthalpy on cells between grid points,
 *   driven by time-integrated MOC face mass fluxes; MUSCL (van Leer) reconstruction; Strang-split
 *   exact exponential heat exchange and friction dissipation.
 */
export interface Orifice {
  id: string;
  pipe: number;
  localPoint: number;
  globalPoint: number;
  fullAreaM2: number;
  cd: number;
  pExtPa: number;
  /** open area fraction in [0,1], set by the driver */
  openFraction: number;
  massFlowKgS: number;
  cumulativeMassKg: number;
  peakMassFlowKgS: number;
  /** internal: outflow computed for the step being assembled */
  pendingMassFlow?: number;
}

export interface TransientOptions {
  /** transported: viscosity from transported T, Y_w; fixed_reference: frozen at init (fixed-property observer) */
  viscosityMode: 'transported' | 'fixed_reference';
  transport: boolean;
  checkPhaseBoundary: boolean;
}

export interface MassLedger {
  boundaryInflowKg: number;
  leakOutflowKg: number;
  initialInventoryKg: number;
}

const DEFAULT_OPTIONS: TransientOptions = { viscosityMode: 'transported', transport: true, checkPhaseBoundary: true };

export class TransientNetwork {
  readonly net: CompiledNetwork;
  readonly options: TransientOptions;
  readonly dt: number;
  t = 0;
  stepCount = 0;

  p: Float64Array;
  uL: Float64Array;
  uR: Float64Array;
  private pN: Float64Array;
  private uLN: Float64Array;
  private uRN: Float64Array;
  nodeP: Float64Array;
  devM: Float64Array;
  pumpSpeed: Float64Array;
  valveOpening: Float64Array;

  // inputs, set by the driver before each step (values at the end of the step)
  bcPressure: Float64Array;
  bcMassFlow: Float64Array;
  bcTemperature: Float64Array;
  bcWaterFraction: Float64Array;
  pumpCommand: Float64Array;
  valveCommand: Float64Array;
  ambientK: Float64Array;

  // transport state
  cellM: Float64Array;
  cellMY: Float64Array;
  cellMH: Float64Array;
  cellT: Float64Array;
  cellY: Float64Array;
  nuPt: Float64Array;
  nodeMixT: Float64Array;
  nodeMixY: Float64Array;
  private fluxL: Float64Array;
  private fluxR: Float64Array;
  private srcAcc: Float64Array;
  private devAcc: Float64Array;
  private lastInj: Float64Array;
  private tAcc = 0;
  private nextTransportDt: number;
  lastTransportDt = 0;

  orifices: Orifice[] = [];
  private orificeAt: Int32Array;
  private pRef: Float64Array;
  ledger: MassLedger;
  private lastBoundaryInflow = 0;
  private lastLeakOutflow = 0;

  /** lagged Darcy friction factor at grid points (refreshed every frictionRefreshSteps) */
  private fPt: Float64Array;
  private fAge = 0;
  readonly frictionRefreshSteps: number;

  // scratch for nodes
  private aN: Float64Array;
  private bN: Float64Array;
  private endC: Float64Array; // per pipe: [C_start, B_start, C_end, B_end]

  constructor(net: CompiledNetwork, steady: SteadySolution, controls: { pumpSpeed: Float64Array; valveOpening: Float64Array; ambientK: Float64Array; boundary: { pressurePa: Float64Array; massFlowKgS: Float64Array; temperatureK: Float64Array; waterMassFraction: Float64Array } }, options: Partial<TransientOptions> = {}) {
    this.net = net;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.dt = net.dt;
    const nP = net.nPoints;
    const nN = net.nodes.length;
    const nD = net.devices.length;
    this.p = steady.pointP.slice();
    this.uL = steady.pointU.slice();
    this.uR = steady.pointU.slice();
    this.pN = new Float64Array(nP);
    this.uLN = new Float64Array(nP);
    this.uRN = new Float64Array(nP);
    this.nodeP = steady.nodeP.slice();
    this.devM = steady.deviceMassFlow.slice();
    this.pumpSpeed = controls.pumpSpeed.slice();
    this.valveOpening = controls.valveOpening.slice();
    this.pumpCommand = controls.pumpSpeed.slice();
    this.valveCommand = controls.valveOpening.slice();
    this.ambientK = controls.ambientK.slice();
    this.bcPressure = controls.boundary.pressurePa.slice();
    this.bcMassFlow = controls.boundary.massFlowKgS.slice();
    this.bcTemperature = controls.boundary.temperatureK.slice();
    this.bcWaterFraction = controls.boundary.waterMassFraction.slice();
    this.lastInj = new Float64Array(nN);
    net.nodes.forEach((nd, i) => {
      if (nd.kind === 'source') this.lastInj[i] = this.bcMassFlow[i]!;
    });

    this.cellT = steady.cellT.slice();
    this.cellY = steady.cellY.slice();
    this.cellM = new Float64Array(net.nCells);
    this.cellMY = new Float64Array(net.nCells);
    this.cellMH = new Float64Array(net.nCells);
    for (const pp of net.pipes) {
      for (let k = 0; k < pp.n; k++) {
        const c = pp.cellOffset + k;
        const M = pp.rho * pp.A * pp.dx;
        this.cellM[c] = M;
        this.cellMY[c] = M * this.cellY[c]!;
        this.cellMH[c] = M * pp.fluid.heatCapacity(this.cellY[c]!) * this.cellT[c]!;
      }
    }
    this.nuPt = new Float64Array(nP);
    this.computePointViscosity(steady.cellMu, this.nuPt);
    this.nodeMixT = steady.nodeMixT.slice();
    this.nodeMixY = steady.nodeMixY.slice();
    this.fluxL = new Float64Array(nP);
    this.fluxR = new Float64Array(nP);
    this.srcAcc = new Float64Array(nN);
    this.devAcc = new Float64Array(nD);
    this.orificeAt = new Int32Array(nP).fill(-1);
    this.aN = new Float64Array(nN);
    this.bN = new Float64Array(nN);
    this.endC = new Float64Array(net.pipes.length * 4);
    this.pRef = new Float64Array(net.pipes.length);
    for (const pp of net.pipes) {
      let s = 0;
      for (let i = 0; i <= pp.n; i++) s += this.p[pp.offset + i]!;
      this.pRef[pp.index] = s / (pp.n + 1);
    }
    this.fPt = new Float64Array(nP);
    this.frictionRefreshSteps = Math.max(1, Math.round(0.1 / this.dt));
    this.refreshFriction();
    this.nextTransportDt = this.computeTransportInterval();
    this.ledger = { boundaryInflowKg: 0, leakOutflowKg: 0, initialInventoryKg: this.inventoryKg() };
    this.lastBoundaryInflow = this.boundaryInflowRate();
  }

  /**
   * Turbulent/transition friction factor cached at grid points from the current state. The MOC loop
   * uses the exact laminar law whenever the local Re <= 2000 and the lagged (<= 0.1 s old) cached
   * factor otherwise: f varies slowly with Re, and this avoids iterating Colebrook twice per point/step.
   */
  private refreshFriction(): void {
    const model = this.net.settings.frictionModel;
    for (const pp of this.net.pipes) {
      for (let i = 0; i <= pp.n; i++) {
        const g = pp.offset + i;
        const u = 0.5 * (Math.abs(this.uL[g]!) + Math.abs(this.uR[g]!));
        const re = Math.max((u * pp.D) / this.nuPt[g]!, RE_LAMINAR_MAX + 1);
        this.fPt[g] = frictionFactor(re, pp.relRough, model);
      }
    }
    this.fAge = 0;
  }

  /** Point viscosity from cell viscosities (cell average for interior points). */
  private computePointViscosity(cellMu: Float64Array, out: Float64Array): void {
    for (const pp of this.net.pipes) {
      for (let i = 0; i <= pp.n; i++) {
        const kL = Math.max(0, i - 1);
        const kR = Math.min(pp.n - 1, i);
        const mu = 0.5 * (cellMu[pp.cellOffset + kL]! + cellMu[pp.cellOffset + kR]!);
        out[pp.offset + i] = mu / pp.rho;
      }
    }
  }

  addOrifice(spec: { id: string; pipe: number; localPoint: number; fullAreaM2: number; cd: number; pExtPa: number }): Orifice {
    const pp = this.net.pipes[spec.pipe]!;
    if (spec.localPoint < 1 || spec.localPoint > pp.n - 1) {
      throw new ModelDomainError('UNSUPPORTED_ACTION', `Orifice must be at an interior grid point (1..${pp.n - 1})`);
    }
    const g = pp.offset + spec.localPoint;
    if (this.orificeAt[g]! >= 0) throw new ModelDomainError('UNSUPPORTED_ACTION', 'Only one orifice per grid point is supported');
    const o: Orifice = { ...spec, globalPoint: g, openFraction: 0, massFlowKgS: 0, cumulativeMassKg: 0, peakMassFlowKgS: 0 };
    this.orificeAt[g] = this.orifices.length;
    this.orifices.push(o);
    return o;
  }

  /** Linearised liquid inventory consistent with the acoustic model: sum (rho A + A (p - p_ref)/c^2) dx. */
  inventoryKg(): number {
    let M = 0;
    for (const pp of this.net.pipes) {
      const pr = this.pRef[pp.index]!;
      let s = 0;
      for (let i = 0; i <= pp.n; i++) {
        const w = i === 0 || i === pp.n ? 0.5 : 1;
        s += w * (pp.rho * pp.A + (pp.A * (this.p[pp.offset + i]! - pr)) / (pp.c * pp.c));
      }
      M += s * pp.dx;
    }
    return M;
  }

  /** Net mass inflow rate into the pipe system through all boundary nodes (pressure + sources) [kg/s]. */
  boundaryInflowRate(): number {
    let s = 0;
    const net = this.net;
    for (const nd of net.nodes) {
      if (nd.kind === 'source') {
        s += this.bcMassFlow[nd.index]!;
      } else if (nd.kind === 'pressure') {
        for (const e of nd.ends) {
          const pp = net.pipes[e.pipe]!;
          const g = e.end === 0 ? pp.offset : pp.offset + pp.n;
          const uOut = e.end === 0 ? this.uR[g]! : -this.uL[g]!;
          s += pp.rho * pp.A * uOut;
        }
        for (const d of nd.devices) {
          const m = this.devM[d.dev]!;
          s += d.side === 'from' ? m : -m;
        }
      }
    }
    return s;
  }

  leakOutflowRate(): number {
    let s = 0;
    for (const o of this.orifices) s += o.massFlowKgS;
    return s;
  }

  /** mass flow [kg/s] at a grid point (right side) */
  pointMassFlow(g: number): number {
    const pp = this.net.pipes[this.net.pipeOfPoint[g]!]!;
    return pp.rho * pp.A * this.uR[g]!;
  }

  private computeTransportInterval(): number {
    const st = this.net.settings;
    let dtMax = st.maxTransportIntervalS;
    for (const pp of this.net.pipes) {
      let um = 0;
      for (let i = 0; i <= pp.n; i++) um = Math.max(um, Math.abs(this.uL[pp.offset + i]!), Math.abs(this.uR[pp.offset + i]!));
      if (um > 1e-9) dtMax = Math.min(dtMax, (st.transportCourant * pp.dx) / um);
    }
    return Math.max(dtMax, this.dt);
  }

  step(): void {
    const saved = [this.nodeP.slice(), this.devM.slice(), this.pumpSpeed.slice(), this.valveOpening.slice()] as const;
    try {
      this.stepInner();
    } catch (e) {
      this.nodeP.set(saved[0]);
      this.devM.set(saved[1]);
      this.pumpSpeed.set(saved[2]);
      this.valveOpening.set(saved[3]);
      throw e;
    }
  }

  private stepInner(): void {
    const net = this.net;
    const dt = this.dt;
    const p = this.p;
    const uL = this.uL;
    const uR = this.uR;
    const pN = this.pN;
    const uLN = this.uLN;
    const uRN = this.uRN;
    const z = net.zPt;
    const nu = this.nuPt;
    const model = net.settings.frictionModel;
    const tNew = this.t + dt;

    // 1. actuators
    for (const d of net.devices) {
      if (d.kind === 'pump') {
        this.pumpSpeed[d.index] = firstOrderActuator(this.pumpSpeed[d.index]!, this.pumpCommand[d.index]!, dt, d.pump!.speedTimeConstantS);
      } else {
        this.valveOpening[d.index] = rateLimitedStroke(this.valveOpening[d.index]!, this.valveCommand[d.index]!, dt, d.valve!.strokeTimeS);
      }
    }

    if (++this.fAge >= this.frictionRefreshSteps) this.refreshFriction();
    const fPt = this.fPt;
    // 2. interior points and end characteristics
    for (const pp of net.pipes) {
      const off = pp.offset;
      const n = pp.n;
      const cr = pp.courant;
      const cr1 = 1 - cr;
      const Z = pp.Z;
      const D = pp.D;
      const cg = pp.rho * G;
      const fk = dt / (2 * D);
      const locK = (pp.localK * D) / pp.L;
      const lamK = 64 / D;
      const fric = (u: number, nuF: number, fa: number, fb: number): number => {
        const au = Math.abs(u);
        return (au * D <= RE_LAMINAR_MAX * nuF ? lamK * nuF : (cr * fa + cr1 * fb) * au) + locK * au;
      };
      for (let i = 1; i < n; i++) {
        const g = off + i;
        const pR = cr * p[g - 1]! + cr1 * p[g]!;
        const uRf = cr * uR[g - 1]! + cr1 * uL[g]!;
        const zR = cr * z[g - 1]! + cr1 * z[g]!;
        const nuR = cr * nu[g - 1]! + cr1 * nu[g]!;
        const fR = fric(uRf, nuR, fPt[g - 1]!, fPt[g]!);
        const BP = Z * (1 + fk * fR);
        const CP = pR + Z * uRf - cg * (z[g]! - zR);
        const pS = cr * p[g + 1]! + cr1 * p[g]!;
        const uSf = cr * uL[g + 1]! + cr1 * uR[g]!;
        const zS = cr * z[g + 1]! + cr1 * z[g]!;
        const nuS = cr * nu[g + 1]! + cr1 * nu[g]!;
        const fS = fric(uSf, nuS, fPt[g + 1]!, fPt[g]!);
        const BM = Z * (1 + fk * fS);
        const CM = pS - Z * uSf + cg * (zS - z[g]!);
        const oi = this.orificeAt[g]!;
        if (oi < 0) {
          const u = (CP - CM) / (BP + BM);
          pN[g] = CP - BP * u;
          uLN[g] = u;
          uRN[g] = u;
        } else {
          this.solveOrifice(oi, pp.A, pp.rho, CP, BP, CM, BM, g);
        }
      }
      // start: C- characteristic from foot between point 0 (right side) and 1 (left side)
      {
        const g = off;
        const pS = cr * p[g + 1]! + cr1 * p[g]!;
        const uSf = cr * uL[g + 1]! + cr1 * uR[g]!;
        const zS = cr * z[g + 1]! + cr1 * z[g]!;
        const nuS = cr * nu[g + 1]! + cr1 * nu[g]!;
        const fS = fric(uSf, nuS, fPt[g + 1]!, fPt[g]!);
        const BM = Z * (1 + fk * fS);
        const CM = pS - Z * uSf + cg * (zS - z[g]!);
        this.endC[4 * pp.index] = CM;
        this.endC[4 * pp.index + 1] = BM;
      }
      // end: C+ characteristic from foot between n-1 (right side) and n (left side)
      {
        const g = off + n;
        const pR = cr * p[g - 1]! + cr1 * p[g]!;
        const uRf = cr * uR[g - 1]! + cr1 * uL[g]!;
        const zR = cr * z[g - 1]! + cr1 * z[g]!;
        const nuR = cr * nu[g - 1]! + cr1 * nu[g]!;
        const fR = fric(uRf, nuR, fPt[g - 1]!, fPt[g]!);
        const BP = Z * (1 + fk * fR);
        const CP = pR + Z * uRf - cg * (z[g]! - zR);
        this.endC[4 * pp.index + 2] = CP;
        this.endC[4 * pp.index + 3] = BP;
      }
    }

    // 3. node affine relations: sum rho A u_out = a p - b
    const aN = this.aN;
    const bN = this.bN;
    for (const nd of net.nodes) {
      let a = 0;
      let b = 0;
      for (const e of nd.ends) {
        const pp = net.pipes[e.pipe]!;
        const C = this.endC[4 * pp.index + (e.end === 0 ? 0 : 2)]!;
        const B = this.endC[4 * pp.index + (e.end === 0 ? 1 : 3)]!;
        const w = (pp.rho * pp.A) / B;
        a += w;
        b += w * C;
      }
      aN[nd.index] = a;
      bN[nd.index] = b;
    }
    const nodePNew = this.nodeP; // overwritten below; restored on failure by caller semantics (only pN arrays matter)
    const nodePOld = nodePNew.slice();
    const devMOld = this.devM.slice();
    const injNow = (i: number): number => (net.nodes[i]!.kind === 'source' ? this.bcMassFlow[i]! : 0);
    for (const nd of net.nodes) {
      if (nd.devices.length > 0) continue;
      if (nd.kind === 'pressure') nodePNew[nd.index] = this.bcPressure[nd.index]!;
      else {
        if (!(aN[nd.index]! > 0)) throw new ModelDomainError('INVALID_TOPOLOGY', `Node ${nd.id} has no pipe connection`);
        nodePNew[nd.index] = (bN[nd.index]! + injNow(nd.index)) / aN[nd.index]!;
      }
    }
    // devices
    for (const d of net.devices) {
      const sN = net.nodes[d.from]!;
      const tN = net.nodes[d.to]!;
      const affine = (nd: typeof sN): [number, number] =>
        nd.kind === 'pressure' ? [this.bcPressure[nd.index]!, 0] : [(bN[nd.index]! + injNow(nd.index)) / aN[nd.index]!, 1 / aN[nd.index]!];
      const [p0s, ks] = affine(sN);
      const [p0t, kt] = affine(tN);
      let m = 0;
      if (d.kind === 'pump') {
        const s = this.pumpSpeed[d.index]!;
        const rho = d.rho;
        const curve = d.curve!;
        const F = (mm: number): [number, number] => {
          const q = mm / rho;
          return [p0t - p0s + (kt + ks) * mm - rho * G * pumpHead(curve, q, s), kt + ks - G * pumpHeadDerivative(curve, q, s)];
        };
        if (d.pump!.checkValve && F(0)[0] >= 0) m = 0;
        else {
          m = solveMonotone(F, this.devM[d.index]!, Math.max(1, Math.abs(this.devM[d.index]!)), true, 1e-12);
          if (d.pump!.checkValve && m < 0) m = 0;
        }
      } else {
        const K = valveLossCoefficient(d.valve!, this.valveOpening[d.index]!);
        if (Number.isFinite(K)) {
          const P0 = p0s - p0t;
          const beta = ks + kt;
          const kap = K / (2 * d.rho * d.areaM2 * d.areaM2);
          const aP = Math.abs(P0);
          const mm = (2 * aP) / (beta + Math.sqrt(beta * beta + 4 * kap * aP));
          m = P0 >= 0 ? mm : -mm;
        } else m = 0;
      }
      this.devM[d.index] = m;
      nodePNew[d.from] = p0s - ks * m;
      nodePNew[d.to] = p0t + kt * m;
    }
    // 4. pipe end states
    for (const pp of net.pipes) {
      const gs = pp.offset;
      const ge = pp.offset + pp.n;
      const ps = nodePNew[pp.from]!;
      const pe = nodePNew[pp.to]!;
      const us = (ps - this.endC[4 * pp.index]!) / this.endC[4 * pp.index + 1]!;
      const ue = -(pe - this.endC[4 * pp.index + 2]!) / this.endC[4 * pp.index + 3]!;
      pN[gs] = ps;
      uLN[gs] = us;
      uRN[gs] = us;
      pN[ge] = pe;
      uLN[ge] = ue;
      uRN[ge] = ue;
    }

    // 5. validity checks (state not committed on failure)
    for (const pp of net.pipes) {
      const pmin = pp.fluid.minPressurePa;
      for (let i = 0; i <= pp.n; i++) {
        const v = pN[pp.offset + i]!;
        if (!Number.isFinite(v) || !Number.isFinite(uRN[pp.offset + i]!)) {
          this.nodeP.set(nodePOld);
          this.devM.set(devMOld);
          throw new ModelDomainError('NUMERICAL_DIVERGENCE', `Non-finite state in pipe ${pp.id} at x=${(i * pp.dx).toFixed(1)} m`, { t: tNew });
        }
        if (this.options.checkPhaseBoundary && v < pmin) {
          this.nodeP.set(nodePOld);
          this.devM.set(devMOld);
          throw new ModelDomainError(
            'UNSUPPORTED_PHASE_REGIME',
            `Pressure ${(v / 1e5).toFixed(3)} bar a below the liquid-model limit ${(pmin / 1e5).toFixed(2)} bar a in ${pp.id} at x=${(i * pp.dx).toFixed(0)} m: gas release/cavitation is not modelled by M0`,
            { pipeId: pp.id, xM: i * pp.dx, pressurePa: v, t: tNew }
          );
        }
      }
    }

    // 6. commit: transport fluxes, ledger, swap
    const half = 0.5 * dt;
    for (const pp of net.pipes) {
      const ra = pp.rho * pp.A;
      for (let i = 0; i <= pp.n; i++) {
        const g = pp.offset + i;
        this.fluxL[g]! += ra * (uL[g]! + uLN[g]!) * half;
        this.fluxR[g]! += ra * (uR[g]! + uRN[g]!) * half;
      }
    }
    for (const nd of net.nodes) {
      if (nd.kind === 'source') {
        const inj = this.bcMassFlow[nd.index]!;
        this.srcAcc[nd.index]! += (this.lastInj[nd.index]! + inj) * half;
        this.lastInj[nd.index] = inj;
      }
    }
    for (const d of net.devices) this.devAcc[d.index]! += (devMOld[d.index]! + this.devM[d.index]!) * half;
    for (const o of this.orifices) {
      const prev = o.massFlowKgS;
      o.massFlowKgS = o.pendingMassFlow ?? 0;
      o.cumulativeMassKg += (prev + o.massFlowKgS) * half;
      o.peakMassFlowKgS = Math.max(o.peakMassFlowKgS, o.massFlowKgS);
    }
    this.p = pN;
    this.pN = p;
    this.uL = uLN;
    this.uLN = uL;
    this.uR = uRN;
    this.uRN = uR;
    this.t = tNew;
    this.stepCount++;
    const inflow = this.boundaryInflowRate();
    const leak = this.leakOutflowRate();
    this.ledger.boundaryInflowKg += (this.lastBoundaryInflow + inflow) * half;
    this.ledger.leakOutflowKg += (this.lastLeakOutflow + leak) * half;
    this.lastBoundaryInflow = inflow;
    this.lastLeakOutflow = leak;

    // 7. transport sub-step
    if (this.options.transport) {
      this.tAcc += dt;
      if (this.tAcc >= this.nextTransportDt - 1e-12) {
        this.transportUpdate(this.tAcc);
        this.lastTransportDt = this.tAcc;
        this.tAcc = 0;
        this.nextTransportDt = this.computeTransportInterval();
      }
    }
  }

  private solveOrifice(oi: number, A: number, rho: number, CP: number, BP: number, CM: number, BM: number, g: number): void {
    const o = this.orifices[oi]!;
    const a = A / BP + A / BM;
    const b = (A * CP) / BP + (A * CM) / BM;
    const kap = o.cd * o.fullAreaM2 * o.openFraction * Math.sqrt(2 / rho);
    let pP: number;
    let q: number;
    if (kap <= 0) {
      pP = b / a;
      q = 0;
    } else {
      const c0 = b - a * o.pExtPa;
      if (c0 <= 0) {
        throw new ModelDomainError(
          'UNSUPPORTED_PHASE_REGIME',
          `Local pressure at leak ${o.id} would fall to the external pressure: reverse inflow through the hole is not supported by M0`,
          { orificeId: o.id }
        );
      }
      const y = (2 * c0) / (kap + Math.sqrt(kap * kap + 4 * a * c0));
      pP = o.pExtPa + y * y;
      q = kap * y;
    }
    this.pN[g] = pP;
    this.uLN[g] = (CP - pP) / BP;
    this.uRN[g] = (pP - CM) / BM;
    o.pendingMassFlow = rho * q;
  }

  /** conservative FV transport of mass, water mass and enthalpy with Strang-split heat exchange */
  private transportUpdate(dtTr: number): void {
    const net = this.net;
    const halfDt = 0.5 * dtTr;
    this.heatExchange(halfDt, dtTr);
    // node mixing (several passes to propagate through devices)
    const nN = net.nodes.length;
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < nN; i++) {
        const nd = net.nodes[i]!;
        if (nd.kind === 'pressure') {
          this.nodeMixT[i] = this.bcTemperature[i]!;
          this.nodeMixY[i] = this.bcWaterFraction[i]!;
          continue;
        }
        let ms = 0;
        let hs = 0;
        let cs = 0;
        let ys = 0;
        for (const e of nd.ends) {
          const pp = net.pipes[e.pipe]!;
          const inflow = e.end === 0 ? -this.fluxR[pp.offset]! : this.fluxL[pp.offset + pp.n]!;
          if (inflow > 0) {
            const c = e.end === 0 ? pp.cellOffset : pp.cellOffset + pp.n - 1;
            const Y = this.cellY[c]!;
            const cp = pp.fluid.heatCapacity(Y);
            ms += inflow;
            cs += inflow * cp;
            hs += inflow * cp * this.cellT[c]!;
            ys += inflow * Y;
          }
        }
        for (const d of nd.devices) {
          const dev = net.devices[d.dev]!;
          const acc = this.devAcc[d.dev]!;
          const inflow = d.side === 'to' ? acc : -acc;
          if (inflow > 0) {
            const up = d.side === 'to' ? dev.from : dev.to;
            const fl = net.pipes[nd.ends[0]!.pipe]!.fluid;
            const cp = fl.heatCapacity(this.nodeMixY[up]!);
            ms += inflow;
            cs += inflow * cp;
            hs += inflow * cp * this.nodeMixT[up]!;
            ys += inflow * this.nodeMixY[up]!;
          }
        }
        if (nd.kind === 'source' && this.srcAcc[i]! > 0) {
          const inflow = this.srcAcc[i]!;
          const fl = net.pipes[nd.ends[0]!.pipe]!.fluid;
          const Y = this.bcWaterFraction[i]!;
          const cp = fl.heatCapacity(Y);
          ms += inflow;
          cs += inflow * cp;
          hs += inflow * cp * this.bcTemperature[i]!;
          ys += inflow * Y;
        }
        if (ms > 1e-12) {
          this.nodeMixT[i] = hs / cs;
          this.nodeMixY[i] = ys / ms;
        } // else: no inflow (stagnant node) -> previous mixed state is kept explicitly
      }
    }
    // cell update per pipe
    for (const pp of net.pipes) {
      const n = pp.n;
      const co = pp.cellOffset;
      const po = pp.offset;
      const Ycell = this.cellY;
      const hCell = (k: number): number => this.cellMH[co + k]! / this.cellM[co + k]!;
      const slopeY = new Float64Array(n);
      const slopeH = new Float64Array(n);
      for (let k = 1; k < n - 1; k++) {
        slopeY[k] = vanLeer(Ycell[co + k]! - Ycell[co + k - 1]!, Ycell[co + k + 1]! - Ycell[co + k]!);
        slopeH[k] = vanLeer(hCell(k) - hCell(k - 1), hCell(k + 1) - hCell(k));
      }
      const fromY = this.nodeMixY[pp.from]!;
      const fromH = pp.fluid.heatCapacity(fromY) * this.nodeMixT[pp.from]!;
      const toY = this.nodeMixY[pp.to]!;
      const toH = pp.fluid.heatCapacity(toY) * this.nodeMixT[pp.to]!;
      // face values per point g = po + i. leftward/rightward fluxes may differ at orifice points
      const newM = new Float64Array(n);
      const newMY = new Float64Array(n);
      const newMH = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        newM[k] = this.cellM[co + k]!;
        newMY[k] = this.cellMY[co + k]!;
        newMH[k] = this.cellMH[co + k]!;
      }
      const edge = (k: number, side: 1 | -1, flux: number): [number, number] => {
        const M = this.cellM[co + k]!;
        const nuC = Math.min(1, Math.abs(flux) / M);
        const f = 0.5 * side * (1 - nuC);
        return [Ycell[co + k]! + f * slopeY[k]!, hCell(k) + f * slopeH[k]!];
      };
      for (let i = 0; i <= n; i++) {
        const g = po + i;
        // left side of point i belongs to cell i-1 (right face), right side to cell i (left face)
        const FLp = this.fluxL[g]!; // mass crossing from cell i-1 into the point (positive = +x)
        const FRp = this.fluxR[g]!; // mass crossing from the point into cell i
        if (i > 0) {
          let val: [number, number];
          if (FLp >= 0) val = edge(i - 1, 1, FLp);
          else val = i < n ? edge(i, -1, FLp) : [toY, toH];
          newM[i - 1]! -= FLp;
          newMY[i - 1]! -= FLp * val[0];
          newMH[i - 1]! -= FLp * val[1];
        }
        if (i < n) {
          let val: [number, number];
          if (FRp >= 0) val = i > 0 ? edge(i - 1, 1, FRp) : [fromY, fromH];
          else val = edge(i, -1, FRp);
          newM[i]! += FRp;
          newMY[i]! += FRp * val[0];
          newMH[i]! += FRp * val[1];
        }
      }
      for (let k = 0; k < n; k++) {
        const c = co + k;
        const M = newM[k]!;
        if (!(M > 0)) throw new ModelDomainError('NUMERICAL_DIVERGENCE', `Transport emptied a cell in ${pp.id}`);
        this.cellM[c] = M;
        this.cellMY[c] = newMY[k]!;
        this.cellMH[c] = newMH[k]!;
        const Y = newMY[k]! / M;
        this.cellY[c] = Y;
        this.cellT[c] = newMH[k]! / M / pp.fluid.heatCapacity(Y);
      }
    }
    this.heatExchange(halfDt, dtTr);
    this.fluxL.fill(0);
    this.fluxR.fill(0);
    this.srcAcc.fill(0);
    this.devAcc.fill(0);
    if (this.options.viscosityMode === 'transported') this.updateViscosity();
  }

  private heatExchange(dtHeat: number, dtTr: number): void {
    const net = this.net;
    for (const pp of net.pipes) {
      const Tamb = this.ambientK[pp.index]!;
      const hl = pp.U * Math.PI * pp.Do;
      for (let k = 0; k < pp.n; k++) {
        const c = pp.cellOffset + k;
        const Y = this.cellY[c]!;
        const cp = pp.fluid.heatCapacity(Y);
        const g = pp.offset + k;
        const u = (this.fluxR[g]! + this.fluxL[g + 1]!) / (2 * pp.rho * pp.A * dtTr);
        const nuC = 0.5 * (this.nuPt[g]! + this.nuPt[g + 1]!);
        const fU = frictionTimesSpeed(u, pp.D, nuC, pp.relRough, net.settings.frictionModel);
        const qf = (fU * pp.rho * pp.A * u * u) / (2 * pp.D);
        const cap = pp.rho * pp.A * cp;
        let T = this.cellT[c]!;
        if (hl > 0) {
          const Teq = Tamb + qf / hl;
          T = Teq + (T - Teq) * Math.exp((-hl * dtHeat) / cap);
        } else T = T + (qf * dtHeat) / cap;
        this.cellT[c] = T;
        this.cellMH[c] = this.cellM[c]! * cp * T;
      }
    }
  }

  private updateViscosity(): void {
    const net = this.net;
    const mu = new Float64Array(net.nCells);
    for (const pp of net.pipes) {
      for (let k = 0; k < pp.n; k++) {
        const c = pp.cellOffset + k;
        const pm = 0.5 * (this.p[pp.offset + k]! + this.p[pp.offset + k + 1]!);
        mu[c] = pp.fluid.viscosity(this.cellT[c]!, this.cellY[c]!, pm);
      }
    }
    this.computePointViscosity(mu, this.nuPt);
  }
}

function vanLeer(a: number, b: number): number {
  const ab = a * b;
  return ab > 0 ? (2 * ab) / (a + b) : 0;
}
