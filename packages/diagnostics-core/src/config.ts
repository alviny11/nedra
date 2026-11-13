import type { PublicScenarioConfig } from '@pipetwin/contracts';

/** A metered control volume for the integral mass balance. */
export interface MassBalanceGroup {
  id: string;
  name: string;
  /** mass-flow meters whose positive reading enters the control volume */
  inflowSensorIds: string[];
  /** mass-flow meters whose positive reading leaves the control volume */
  outflowSensorIds: string[];
  /** pipe segments inside the control volume (for the observer inventory term) */
  segments: Array<{ edgeId: string; fromM: number; toM: number }>;
}

export interface DetectorConfig {
  detectorVersion: string;
  /** observer initialisation window (averages boundary inputs) */
  initWindowS: number;
  /** end of the calibration window (no events assumed before); residual statistics are fixed after it */
  warmupS: number;
  /** residuals are ignored this long after observer start (initial mismatch transient) */
  settleS: number;
  binS: number;
  boundaryFilterTauS: { pressure: number; massFlow: number; temperature: number; waterFraction: number };
  maxBoundaryAgeS: number;
  sigmaFloor: { pressure: number; massFlow: number; temperature: number; waterFraction: number; volumeFlow: number };
  d0: { zThreshold: number; holdS: number; releaseS: number };
  d1: {
    cusumK: number;
    cusumH: number;
    mbWindowS: number;
    mbZThreshold: number;
    leakConfirmS: number;
    sensorFaultZ: number;
    sensorFaultOthersMaxZ: number;
    sensorFaultConfirmS: number;
    ambiguousAfterS: number;
    recoverS: number;
    commandGuardS: number;
    minPressureSensorsForLeak: number;
  };
  wave: {
    baselineS: number;
    detectSigma: number;
    consecutive: number;
    amplitudeFraction: number;
    windowS: number;
    candidateStepM: number;
    minTimingSigmaS: number;
  };
  steadyFit: { coarseStepM: number; fineStepM: number; afterConfirmS: number; preWindowS: number; postWindowS: number };
  featureWindowS: number;
  featureStrideS: number;
  massBalanceGroups: MassBalanceGroup[];
}

export const DETECTOR_VERSION = 'pipetwin-diag-0.1.0';

export function defaultDetectorConfig(groups: MassBalanceGroup[] = []): DetectorConfig {
  return {
    detectorVersion: DETECTOR_VERSION,
    initWindowS: 2,
    warmupS: 180,
    settleS: 30,
    binS: 1,
    boundaryFilterTauS: { pressure: 0.25, massFlow: 3, temperature: 5, waterFraction: 5 },
    maxBoundaryAgeS: 5,
    sigmaFloor: { pressure: 250, massFlow: 0.05, temperature: 0.05, waterFraction: 0.002, volumeFlow: 5e-5 },
    d0: { zThreshold: 6, holdS: 10, releaseS: 30 },
    d1: {
      cusumK: 0.75,
      cusumH: 25,
      mbWindowS: 60,
      mbZThreshold: 6,
      leakConfirmS: 3,
      sensorFaultZ: 8,
      sensorFaultOthersMaxZ: 3,
      sensorFaultConfirmS: 15,
      ambiguousAfterS: 45,
      recoverS: 30,
      commandGuardS: 90,
      minPressureSensorsForLeak: 2
    },
    wave: { baselineS: 2, detectSigma: 6, consecutive: 3, amplitudeFraction: 0.3, windowS: 15, candidateStepM: 10, minTimingSigmaS: 0.01 },
    steadyFit: { coarseStepM: 50, fineStepM: 10, afterConfirmS: 40, preWindowS: 30, postWindowS: 20 },
    featureWindowS: 60,
    featureStrideS: 5,
    massBalanceGroups: groups
  };
}

/** Metering scheme of the demonstration field (public knowledge of the meter layout). */
export function demoMassBalanceGroups(cfg: PublicScenarioConfig): MassBalanceGroup[] {
  const has = (id: string): boolean => cfg.sensors.some((s) => s.id === id && s.availability === 'online');
  const groups: MassBalanceGroup[] = [];
  if (['FT-101', 'FT-102', 'FT-103', 'FT-104', 'FT-105'].every(has)) {
    groups.push({
      id: 'mb-oil',
      name: 'Коллектор ДНС-1 → УПН',
      inflowSensorIds: ['FT-101', 'FT-102', 'FT-103'],
      outflowSensorIds: ['FT-104', 'FT-105'],
      segments: [
        { edgeId: 'e2', fromM: 50, toM: 3200 },
        { edgeId: 'e3', fromM: 0, toM: 2100 },
        { edgeId: 'e4', fromM: 0, toM: 2800 },
        { edgeId: 'e5', fromM: 0, toM: 1500 },
        { edgeId: 'e6', fromM: 0, toM: 2400 },
        { edgeId: 'e7', fromM: 0, toM: 250 },
        { edgeId: 'e8', fromM: 0, toM: 780 }
      ]
    });
  }
  if (['FT-201', 'FT-202'].every(has)) {
    groups.push({
      id: 'mb-water',
      name: 'Водовод С-1 → КНС',
      inflowSensorIds: ['FT-201'],
      outflowSensorIds: ['FT-202'],
      segments: [{ edgeId: 'e9', fromM: 20, toM: 1780 }]
    });
  }
  // One balance zone per schematic pipe that is metered at both ends.
  for (const link of cfg.links) {
    if (link.kind !== 'pipe') continue;
    const flows = cfg.sensors.filter((s) => s.kind === 'massFlow' && s.edgeId === link.id && s.availability === 'online' && s.distanceM !== undefined);
    const inlet = flows.find((s) => s.distanceM! <= 1);
    const outlet = [...flows].reverse().find((s) => s.distanceM! >= link.lengthM - 1);
    if (!inlet || !outlet || inlet.id === outlet.id) continue;
    if (groups.some((g) => g.inflowSensorIds.includes(inlet.id) || g.outflowSensorIds.includes(outlet.id))) continue;
    groups.push({
      id: `mb-${link.id}`,
      name: link.name,
      inflowSensorIds: [inlet.id],
      outflowSensorIds: [outlet.id],
      segments: [{ edgeId: link.id, fromM: 0, toM: link.lengthM }]
    });
  }
  return groups;
}
