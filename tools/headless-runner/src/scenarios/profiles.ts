import type { FluidProfile } from '@pipetwin/contracts';
import { SCHEMA_VERSION } from '@pipetwin/contracts';

/**
 * Fluid passports. All oil-related numbers are SYNTHETIC demonstration parameters, not a laboratory
 * passport of a real crude. Water tabulated viscosity follows commonly tabulated IAPWS-2008 values
 * at 0.1 MPa (rounded); the linear density is an approximation around 20 C.
 */

export function waterVerification(): FluidProfile {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'water_verification',
    name: 'Вода (эталон, постоянные свойства)',
    provenance: 'synthetic',
    description: 'Accepted constants rho=1000 kg/m3, mu=1e-3 Pa s for analytic verification; K_s=2.19 GPa.',
    modelVersion: '1.0',
    validPressurePa: [1e4, 1e8],
    validTemperatureK: [278.15, 353.15],
    compositionDefinition: 'single-phase water (Y_w = 1)',
    compositionBounds: { waterMassFraction: [1, 1] },
    referencePressurePa: 1e5,
    referenceTemperatureK: 293.15,
    referenceWaterMassFraction: 1,
    water: {
      densityModel: { kind: 'linear', rhoRefKgM3: 1000, thermalExpansion1K: 0 },
      viscosityModel: { kind: 'constant', muPaS: 1e-3 },
      heatCapacityJkgK: 4180,
      conductivityWmK: 0.6,
      bulkModulusPa: 2.19e9
    },
    mixtureViscosityModel: { kind: 'single_phase' },
    phaseBoundaryModel: { kind: 'min_pressure', minPressurePa: 1e4, note: 'Verification limit well above the vapour pressure of water at <= 45 C.' },
    uncertainty: { densityRel: 0, viscosityRel: 0, soundSpeedRel: 0 },
    standardConditions: { pressurePa: 101325, temperatureK: 293.15 },
    capabilities: ['M0_liquid'],
    notes: ['Constants are accepted for tests, not a property model of real water.']
  };
}

export function waterTabulated(): FluidProfile {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'water_tabulated',
    name: 'Пластовая вода (табл. вязкость чистой воды)',
    provenance: 'correlation',
    sourceUrl: 'https://iapws.org/technical-guidance/release/viscosity',
    description:
      'Viscosity: log-interpolated pure-water values at 0.1 MPa (IAPWS 2008 as commonly tabulated, rounded). Density: linear around 20 C (error up to ~1.5% at the range ends). Salinity is NOT modelled: this is not a brine model.',
    modelVersion: '1.0',
    validPressurePa: [1e5, 1e8],
    validTemperatureK: [273.15, 363.15],
    compositionDefinition: 'single-phase water (Y_w = 1)',
    compositionBounds: { waterMassFraction: [1, 1] },
    referencePressurePa: 1e5,
    referenceTemperatureK: 293.15,
    referenceWaterMassFraction: 1,
    water: {
      densityModel: { kind: 'linear', rhoRefKgM3: 998.2, thermalExpansion1K: 2.1e-4 },
      viscosityModel: {
        kind: 'table_log',
        temperatureK: [273.15, 283.15, 293.15, 303.15, 313.15, 323.15, 333.15, 343.15, 353.15, 363.15],
        viscosityPaS: [1.7914e-3, 1.3059e-3, 1.0016e-3, 0.7972e-3, 0.6527e-3, 0.5465e-3, 0.466e-3, 0.4035e-3, 0.354e-3, 0.3142e-3]
      },
      heatCapacityJkgK: 4180,
      conductivityWmK: 0.6,
      bulkModulusPa: 2.2e9
    },
    mixtureViscosityModel: { kind: 'single_phase' },
    phaseBoundaryModel: {
      kind: 'min_pressure',
      minPressurePa: 1.5e5,
      note: 'Synthetic limit for produced water with residual dissolved gas: below 1.5 bar a gas release is assumed possible.'
    },
    uncertainty: { densityRel: 0.015, viscosityRel: 0.01, soundSpeedRel: 0.02 },
    standardConditions: { pressurePa: 101325, temperatureK: 293.15 },
    capabilities: ['M0_liquid'],
    notes: ['Table bounds are enforced: no extrapolation outside 0..90 C.']
  };
}

/** two-point synthetic oil: mu(20 C) = 22 mPa s, mu(40 C) = 11 mPa s, ln(mu) = a + b/T */
function oilPhase() {
  const b = Math.log(0.022 / 0.011) / (1 / 293.15 - 1 / 313.15);
  const a = Math.log(0.011) - b / 313.15;
  return {
    densityModel: { kind: 'linear' as const, rhoRefKgM3: 850, thermalExpansion1K: 7e-4 },
    viscosityModel: { kind: 'arrhenius' as const, a, bK: b },
    heatCapacityJkgK: 2000,
    conductivityWmK: 0.13,
    bulkModulusPa: 850 * 1300 * 1300
  };
}

export function syntheticOil(): FluidProfile {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'synthetic_oil',
    name: 'Синтетическая нефть (без воды)',
    provenance: 'synthetic',
    description: 'rho_ref=850 kg/m3 @ 40 C/5 bar, c_bulk=1300 m/s (K_s = rho c^2), c_p=2000 J/(kg K), ln mu = a + b/T through 22 mPa s @ 20 C and 11 mPa s @ 40 C.',
    modelVersion: '1.0',
    validPressurePa: [3.5e5, 1e7],
    validTemperatureK: [273.15, 353.15],
    compositionDefinition: 'dead oil after first-stage separation, no free water (Y_w = 0)',
    compositionBounds: { waterMassFraction: [0, 0] },
    referencePressurePa: 5e5,
    referenceTemperatureK: 313.15,
    referenceWaterMassFraction: 0,
    oil: oilPhase(),
    mixtureViscosityModel: { kind: 'single_phase' },
    phaseBoundaryModel: {
      kind: 'min_pressure',
      minPressurePa: 3.5e5,
      note: 'Synthetic: liquid degassed at the separator (4.2 bar a); below 3.5 bar a gas release is assumed possible and M0 is not valid.'
    },
    uncertainty: { densityRel: 0.01, viscosityRel: 0.15, soundSpeedRel: 0.03 },
    standardConditions: { pressurePa: 101325, temperatureK: 293.15 },
    capabilities: ['M0_liquid'],
    notes: ['Not a passport of any real crude.', 'Viscosity law is a two-point fit; used only inside 0..80 C.']
  };
}

export function syntheticOilWater(): FluidProfile {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'synthetic_oil_water',
    name: 'Синтетическая нефть + вода (ветвь В/Н)',
    provenance: 'synthetic',
    description:
      'Oil as synthetic_oil; produced water rho=1010 kg/m3, c_p=4100, K_s=2.3 GPa. Mixture: rho by volume fractions, c_p by mass fractions, K by Wood. Effective viscosity mu_oil(T)*(1-alpha_w)^-2.5 on the water-in-oil branch only (alpha_w <= 0.40). No inversion point is modelled; not calibrated.',
    modelVersion: '1.0',
    validPressurePa: [3.5e5, 1e7],
    validTemperatureK: [273.15, 353.15],
    compositionDefinition: 'Y_w = water MASS fraction in the liquid; water-cut meters report the local VOLUME fraction alpha_w',
    compositionBounds: { waterMassFraction: [0, 0.44] },
    referencePressurePa: 5e5,
    referenceTemperatureK: 313.15,
    referenceWaterMassFraction: 0.18,
    oil: oilPhase(),
    water: {
      densityModel: { kind: 'linear', rhoRefKgM3: 1010, thermalExpansion1K: 3.5e-4 },
      viscosityModel: { kind: 'constant', muPaS: 0.65e-3 },
      heatCapacityJkgK: 4100,
      conductivityWmK: 0.6,
      bulkModulusPa: 2.3e9
    },
    mixtureViscosityModel: { kind: 'wo_emulsion_power', exponent: 2.5, maxWaterVolumeFraction: 0.4, calibrated: false },
    phaseBoundaryModel: {
      kind: 'min_pressure',
      minPressurePa: 3.5e5,
      note: 'Synthetic: liquid degassed at the separator (4.2 bar a); below 3.5 bar a gas release is assumed possible and M0 is not valid.'
    },
    uncertainty: { densityRel: 0.01, viscosityRel: 0.25, soundSpeedRel: 0.04 },
    standardConditions: { pressurePa: 101325, temperatureK: 293.15 },
    capabilities: ['M0_liquid'],
    notes: [
      'Mixture viscosity is an explicitly synthetic smooth dependence in a narrow range (W/O branch).',
      'Outside alpha_w <= 0.40 the model stops with PROFILE_OUT_OF_RANGE instead of extrapolating.'
    ]
  };
}

export function allProfiles(): FluidProfile[] {
  return [waterVerification(), waterTabulated(), syntheticOil(), syntheticOilWater()];
}
