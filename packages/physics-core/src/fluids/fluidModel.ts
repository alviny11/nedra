import type { FluidProfile, PhaseProperties, RestraintModel } from '@pipetwin/contracts';
import { ModelDomainError } from '@pipetwin/contracts';
import { interpLogStrict } from '../numerics/interp';

export interface FluidDeviation {
  viscosityFactor?: number;
  bulkModulusFactor?: number;
}

/**
 * Liquid property model built from a FluidProfile passport.
 * Composition variable: Y_w = water MASS fraction in the liquid. Volume fraction alpha_w is derived.
 * Density averages by volume fractions, heat capacity by mass fractions, bulk modulus by Wood
 * (1/K = sum alpha_k/K_k). Viscosity of the mixture follows the profile's declared model only.
 */
export class FluidModel {
  readonly profile: FluidProfile;
  private readonly muFactor: number;
  private readonly kFactor: number;

  constructor(profile: FluidProfile, deviation: FluidDeviation = {}) {
    this.profile = profile;
    this.muFactor = deviation.viscosityFactor ?? 1;
    this.kFactor = deviation.bulkModulusFactor ?? 1;
    if (!profile.oil && !profile.water) {
      throw new ModelDomainError('INVALID_SCHEMA', `Fluid profile ${profile.id} defines no liquid phase`);
    }
  }

  get id(): string {
    return this.profile.id;
  }

  /** Water mass fraction is forced for single-phase profiles. */
  normalizeYw(yw: number): number {
    if (!this.profile.oil) return 1;
    if (!this.profile.water) return 0;
    return yw;
  }

  checkComposition(yw: number): void {
    const [lo, hi] = this.profile.compositionBounds.waterMassFraction;
    const y = this.normalizeYw(yw);
    if (y < lo - 1e-9 || y > hi + 1e-9) {
      throw new ModelDomainError(
        'PROFILE_OUT_OF_RANGE',
        `Water mass fraction ${y.toFixed(4)} outside profile ${this.profile.id} bounds [${lo}, ${hi}]`,
        { value: y, min: lo, max: hi, profileId: this.profile.id }
      );
    }
  }

  checkTemperature(T: number): void {
    const [lo, hi] = this.profile.validTemperatureK;
    if (!(T >= lo - 1e-9 && T <= hi + 1e-9)) {
      throw new ModelDomainError(
        'PROFILE_OUT_OF_RANGE',
        `Temperature ${T.toFixed(2)} K outside profile ${this.profile.id} range [${lo}, ${hi}] K`,
        { value: T, min: lo, max: hi, profileId: this.profile.id }
      );
    }
  }

  get minPressurePa(): number {
    return this.profile.phaseBoundaryModel.minPressurePa;
  }

  private phaseDensity(ph: PhaseProperties, p: number, T: number): number {
    const d = ph.densityModel;
    const K = ph.bulkModulusPa * this.kFactor;
    return d.rhoRefKgM3 * (1 + (p - this.profile.referencePressurePa) / K - d.thermalExpansion1K * (T - this.profile.referenceTemperatureK));
  }

  private phaseViscosity(ph: PhaseProperties, T: number): number {
    const m = ph.viscosityModel;
    switch (m.kind) {
      case 'constant':
        return m.muPaS;
      case 'arrhenius':
        this.checkTemperature(T);
        return Math.exp(m.a + m.bK / T);
      case 'table_log':
        return interpLogStrict(m.temperatureK, m.viscosityPaS, T, `viscosity table of ${this.profile.id}`);
    }
  }

  oilDensity(p: number, T: number): number {
    if (!this.profile.oil) throw new Error('no oil phase');
    return this.phaseDensity(this.profile.oil, p, T);
  }

  waterDensity(p: number, T: number): number {
    if (!this.profile.water) throw new Error('no water phase');
    return this.phaseDensity(this.profile.water, p, T);
  }

  /** local water volume fraction alpha_w from mass fraction Y_w */
  waterVolumeFraction(ywIn: number, p: number, T: number): number {
    const yw = this.normalizeYw(ywIn);
    if (yw <= 0) return 0;
    if (yw >= 1) return 1;
    const rw = this.waterDensity(p, T);
    const ro = this.oilDensity(p, T);
    const vw = yw / rw;
    const vo = (1 - yw) / ro;
    return vw / (vw + vo);
  }

  /** inverse conversion alpha_w -> Y_w (used by observers that read water-cut meters) */
  waterMassFractionFromVolume(alphaW: number, p: number, T: number): number {
    if (!this.profile.oil) return 1;
    if (!this.profile.water) return 0;
    const rw = this.waterDensity(p, T);
    const ro = this.oilDensity(p, T);
    const mw = alphaW * rw;
    const mo = (1 - alphaW) * ro;
    return mw / (mw + mo);
  }

  density(p: number, T: number, ywIn: number): number {
    const yw = this.normalizeYw(ywIn);
    let inv = 0;
    if (this.profile.water && yw > 0) inv += yw / this.waterDensity(p, T);
    if (this.profile.oil && yw < 1) inv += (1 - yw) / this.oilDensity(p, T);
    return 1 / inv;
  }

  heatCapacity(ywIn: number): number {
    const yw = this.normalizeYw(ywIn);
    let cp = 0;
    if (this.profile.water) cp += yw * this.profile.water.heatCapacityJkgK;
    if (this.profile.oil) cp += (1 - yw) * this.profile.oil.heatCapacityJkgK;
    return cp;
  }

  /** Effective dynamic viscosity [Pa s] following the declared mixture model (with strict bounds). */
  viscosity(T: number, ywIn: number, p: number = this.profile.referencePressurePa): number {
    const yw = this.normalizeYw(ywIn);
    this.checkComposition(yw);
    if (!this.profile.oil) return this.phaseViscosity(this.profile.water!, T) * this.muFactor;
    if (!this.profile.water || yw <= 0) return this.phaseViscosity(this.profile.oil, T) * this.muFactor;
    const mm = this.profile.mixtureViscosityModel;
    if (mm.kind === 'single_phase') {
      throw new ModelDomainError('PROFILE_OUT_OF_RANGE', `Profile ${this.profile.id} has no mixture viscosity model for Y_w=${yw}`);
    }
    const alpha = this.waterVolumeFraction(yw, p, T);
    if (alpha > mm.maxWaterVolumeFraction + 1e-9) {
      throw new ModelDomainError(
        'PROFILE_OUT_OF_RANGE',
        `Water volume fraction ${alpha.toFixed(3)} beyond the declared W/O emulsion branch (<= ${mm.maxWaterVolumeFraction})`,
        { alphaW: alpha, max: mm.maxWaterVolumeFraction }
      );
    }
    return this.phaseViscosity(this.profile.oil, T) * Math.pow(1 - alpha, -mm.exponent) * this.muFactor;
  }

  /** Bulk (isentropic) modulus of the liquid mixture by Wood's rule. */
  bulkModulus(p: number, T: number, ywIn: number): number {
    const yw = this.normalizeYw(ywIn);
    const alpha = this.waterVolumeFraction(yw, p, T);
    let inv = 0;
    if (this.profile.water && alpha > 0) inv += alpha / (this.profile.water.bulkModulusPa * this.kFactor);
    if (this.profile.oil && alpha < 1) inv += (1 - alpha) / (this.profile.oil.bulkModulusPa * this.kFactor);
    return 1 / inv;
  }

  /** Sound speed of the unconfined liquid sqrt(K_s / rho). */
  soundSpeedBulk(p: number, T: number, yw: number): number {
    return Math.sqrt(this.bulkModulus(p, T, yw) / this.density(p, T, yw));
  }
}

/** Thin-walled pipe restraint factor chi (Wylie & Streeter). */
export function restraintFactor(model: RestraintModel, poisson: number): number {
  switch (model) {
    case 'expansion_joints':
      return 1;
    case 'anchored_upstream':
      return 1 - poisson / 2;
    case 'anchored_throughout':
      return 1 - poisson * poisson;
  }
}

/** c = [rho (1/K + chi D/(E e))]^(-1/2) — Korteweg/Joukowsky wave speed in an elastic pipe. */
export function effectiveWaveSpeed(
  rho: number,
  bulkModulusPa: number,
  diameterM: number,
  wallThicknessM: number,
  youngModulusPa: number,
  chi: number
): number {
  const compliance = 1 / bulkModulusPa + (chi * diameterM) / (youngModulusPa * wallThicknessM);
  return 1 / Math.sqrt(rho * compliance);
}

/** Wood's low-frequency homogeneous mixture sound speed: 1/(rho_m c_m^2) = sum alpha_k/(rho_k c_k^2). */
export function woodSoundSpeed(phases: Array<{ alpha: number; rho: number; c: number }>): number {
  let rhoM = 0;
  let inv = 0;
  let sumAlpha = 0;
  for (const ph of phases) {
    rhoM += ph.alpha * ph.rho;
    inv += ph.alpha / (ph.rho * ph.c * ph.c);
    sumAlpha += ph.alpha;
  }
  if (Math.abs(sumAlpha - 1) > 1e-9) throw new ModelDomainError('INVALID_SCHEMA', `volume fractions sum to ${sumAlpha}`);
  return 1 / Math.sqrt(rhoM * inv);
}
