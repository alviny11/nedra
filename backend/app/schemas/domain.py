"""Pydantic mirrors of the TypeScript domain contracts (packages/contracts/src).

These models are the source of the JSON Schemas exported to packages/contracts/schemas; the TS side
validates the same shared fixtures with Ajv against those schemas (structural level), and both sides
run their own semantic validation (topology, references). All quantities are SI, pressure absolute.
"""
from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = "1.0.0"

FiniteFloat = Annotated[float, Field(allow_inf_nan=False)]
NonNegFloat = Annotated[float, Field(ge=0, allow_inf_nan=False)]
PosFloat = Annotated[float, Field(gt=0, allow_inf_nan=False)]
Identifier = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.\-]+$")]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class XY(Strict):
    x: FiniteFloat
    y: FiniteFloat


class ElevationPoint(Strict):
    distanceM: NonNegFloat
    elevationM: FiniteFloat


# ----------------------------------------------------------------------------- fluids


class LinearDensityModel(Strict):
    kind: Literal["linear"]
    rhoRefKgM3: PosFloat
    thermalExpansion1K: FiniteFloat


class ViscosityConstant(Strict):
    kind: Literal["constant"]
    muPaS: PosFloat


class ViscosityArrhenius(Strict):
    kind: Literal["arrhenius"]
    a: FiniteFloat
    bK: FiniteFloat


class ViscosityTableLog(Strict):
    kind: Literal["table_log"]
    temperatureK: list[PosFloat] = Field(min_length=2)
    viscosityPaS: list[PosFloat] = Field(min_length=2)


ViscosityModel = Annotated[Union[ViscosityConstant, ViscosityArrhenius, ViscosityTableLog], Field(discriminator="kind")]


class PhaseProperties(Strict):
    densityModel: LinearDensityModel
    viscosityModel: ViscosityModel
    heatCapacityJkgK: PosFloat
    conductivityWmK: PosFloat
    bulkModulusPa: PosFloat


class MixtureSinglePhase(Strict):
    kind: Literal["single_phase"]


class MixtureWoEmulsion(Strict):
    kind: Literal["wo_emulsion_power"]
    exponent: PosFloat
    maxWaterVolumeFraction: Annotated[float, Field(gt=0, le=1)]
    calibrated: bool


MixtureViscosityModel = Annotated[Union[MixtureSinglePhase, MixtureWoEmulsion], Field(discriminator="kind")]


class CompositionBounds(Strict):
    waterMassFraction: tuple[Annotated[float, Field(ge=0, le=1)], Annotated[float, Field(ge=0, le=1)]]


class PhaseBoundary(Strict):
    kind: Literal["min_pressure"]
    minPressurePa: PosFloat
    note: str


class Uncertainty(Strict):
    densityRel: NonNegFloat
    viscosityRel: NonNegFloat
    soundSpeedRel: NonNegFloat


class StandardConditions(Strict):
    pressurePa: PosFloat
    temperatureK: PosFloat


class FluidProfile(Strict):
    schemaVersion: str
    id: Identifier
    name: str
    provenance: Literal["measured", "correlation", "synthetic"]
    sourceUrl: Optional[str] = None
    description: str
    modelVersion: str
    validPressurePa: tuple[PosFloat, PosFloat]
    validTemperatureK: tuple[PosFloat, PosFloat]
    compositionDefinition: str
    compositionBounds: CompositionBounds
    referencePressurePa: PosFloat
    referenceTemperatureK: PosFloat
    referenceWaterMassFraction: Annotated[float, Field(ge=0, le=1)]
    oil: Optional[PhaseProperties] = None
    water: Optional[PhaseProperties] = None
    mixtureViscosityModel: MixtureViscosityModel
    phaseBoundaryModel: PhaseBoundary
    uncertainty: Uncertainty
    standardConditions: StandardConditions
    capabilities: list[Literal["M0_liquid", "M1_acoustic_experiment"]]
    notes: list[str]


# ----------------------------------------------------------------------------- topology


class NodeBoundary(Strict):
    pressurePa: Optional[PosFloat] = None
    massFlowKgS: Optional[NonNegFloat] = None
    temperatureK: PosFloat
    waterMassFraction: Annotated[float, Field(ge=0, le=1)]


class NodeConfig(Strict):
    id: Identifier
    name: str
    kind: Literal["junction", "pressure_boundary", "mass_flow_source", "closed_end"]
    role: Literal[
        "junction",
        "separator_liquid",
        "separator_water",
        "treatment_inlet",
        "water_outlet",
        "tank",
        "well_pad_liquid",
        "pump_suction",
        "pump_discharge",
        "valve_port",
    ]
    elevationM: FiniteFloat
    display: XY
    boundary: Optional[NodeBoundary] = None


class PipeThermal(Strict):
    overallHeatTransferWm2K: NonNegFloat
    referenceOuterDiameterM: PosFloat
    ambientTemperatureK: PosFloat
    insulation: str


class PipeConfig(Strict):
    kind: Literal["pipe"]
    id: Identifier
    name: str
    fromNodeId: Identifier
    toNodeId: Identifier
    lengthM: PosFloat
    innerDiameterM: PosFloat
    wallThicknessM: PosFloat
    roughnessM: NonNegFloat
    youngModulusPa: PosFloat
    poissonRatio: Annotated[float, Field(gt=0, lt=0.5)]
    restraintModel: Literal["expansion_joints", "anchored_upstream", "anchored_throughout"]
    elevationProfile: list[ElevationPoint] = Field(min_length=2)
    displayPolyline: list[XY] = Field(min_length=2)
    thermal: PipeThermal
    fluidProfileId: Identifier
    solverModel: Literal["M0_liquid_moc"]
    localLossK: Optional[NonNegFloat] = None


class PumpCurve(Strict):
    flowM3S: list[NonNegFloat] = Field(min_length=3)
    headM: list[FiniteFloat] = Field(min_length=3)


class PumpEfficiency(Strict):
    flowM3S: list[NonNegFloat]
    eta: list[Annotated[float, Field(gt=0, le=1)]]


class PumpConfig(Strict):
    kind: Literal["pump"]
    id: Identifier
    name: str
    fromNodeId: Identifier
    toNodeId: Identifier
    curve: PumpCurve
    referenceSpeedRpm: PosFloat
    initialSpeedRatio: Annotated[float, Field(ge=0, le=1.2)]
    speedTimeConstantS: NonNegFloat
    checkValve: bool
    allowedFlowM3S: tuple[NonNegFloat, PosFloat]
    efficiency: Optional[PumpEfficiency] = None
    display: XY


class ValveCharacteristic(Strict):
    opening: list[Annotated[float, Field(gt=0, le=1)]] = Field(min_length=2)
    lossCoefficientK: list[PosFloat] = Field(min_length=2)


class ValveConfig(Strict):
    kind: Literal["valve"]
    id: Identifier
    name: str
    fromNodeId: Identifier
    toNodeId: Identifier
    diameterM: PosFloat
    characteristic: ValveCharacteristic
    initialOpening: Annotated[float, Field(ge=0, le=1)]
    strokeTimeS: NonNegFloat
    display: XY


LinkConfig = Annotated[Union[PipeConfig, PumpConfig, ValveConfig], Field(discriminator="kind")]


class SensorConfig(Strict):
    id: Identifier
    name: str
    kind: Literal["pressure", "temperature", "massFlow", "volumeFlow", "waterFraction"]
    edgeId: Optional[Identifier] = None
    distanceM: Optional[NonNegFloat] = None
    nodeId: Optional[Identifier] = None
    sampleRateHz: Annotated[float, Field(gt=0, le=1000)]
    timeConstantS: NonNegFloat
    delayS: NonNegFloat
    noiseStdSI: NonNegFloat
    biasSI: FiniteFloat
    quantizationStepSI: NonNegFloat
    dropoutProbability: Annotated[float, Field(ge=0, lt=1)]
    timestampJitterS: NonNegFloat
    rangeSI: tuple[FiniteFloat, FiniteFloat]
    role: Literal["boundary_input", "residual", "state_assimilation"]
    availability: Literal["online", "offline"]
    boundaryNodeId: Optional[Identifier] = None


class CmdPump(Strict):
    kind: Literal["pump_speed"]
    id: Identifier
    simTimeS: NonNegFloat
    targetId: Identifier
    speedRatio: Annotated[float, Field(ge=0, le=1.2)]


class CmdValve(Strict):
    kind: Literal["valve_opening"]
    id: Identifier
    simTimeS: NonNegFloat
    targetId: Identifier
    opening: Annotated[float, Field(ge=0, le=1)]


class CmdPressure(Strict):
    kind: Literal["boundary_pressure"]
    id: Identifier
    simTimeS: NonNegFloat
    targetId: Identifier
    pressurePa: PosFloat


class CmdFlow(Strict):
    kind: Literal["source_mass_flow"]
    id: Identifier
    simTimeS: NonNegFloat
    targetId: Identifier
    massFlowKgS: NonNegFloat


PublicCommand = Annotated[Union[CmdPump, CmdValve, CmdPressure, CmdFlow], Field(discriminator="kind")]


class ContextElement(Strict):
    id: Identifier
    kind: Literal["well_pad", "gas_liquid_line", "gas_line", "separator", "gas_outlet", "treatment", "water_injection"]
    name: str
    polyline: Optional[list[XY]] = None
    position: Optional[XY] = None
    note: str
    modelLevel: Literal["context_only", "M1_acoustic_experiment"]


class SimulationSettings(Strict):
    targetReachLengthM: PosFloat
    minReachesPerPipe: Annotated[int, Field(ge=2, le=1000)]
    transportCourant: Annotated[float, Field(gt=0, le=1)]
    maxTransportIntervalS: PosFloat
    frictionModel: Literal["colebrook", "haaland"]
    propertyMode: Literal["fixed_acoustic_variable_viscosity", "fixed_all"]
    durationS: Annotated[float, Field(gt=0, le=86400)]


class MapSize(Strict):
    width: PosFloat
    height: PosFloat


class PublicScenarioConfig(Strict):
    schemaVersion: str
    id: Identifier
    name: str
    description: str
    fluidProfiles: list[FluidProfile] = Field(min_length=1, max_length=16)
    nodes: list[NodeConfig] = Field(min_length=2, max_length=200)
    links: list[LinkConfig] = Field(min_length=1, max_length=200)
    sensors: list[SensorConfig] = Field(max_length=500)
    commands: list[PublicCommand] = Field(max_length=2000)
    simulation: SimulationSettings
    contextElements: list[ContextElement] = Field(max_length=200)
    map: MapSize


# ----------------------------------------------------------------------------- truth (operator / evaluator only)


class LeakEvent(Strict):
    kind: Literal["leak"]
    eventId: Identifier
    edgeId: Identifier
    distanceM: PosFloat
    startTimeS: NonNegFloat
    holeDiameterM: PosFloat
    openingDurationS: NonNegFloat
    dischargeCoefficient: Annotated[float, Field(gt=0, le=1)]
    externalPressurePa: PosFloat
    outflowModel: Literal["liquid_orifice"]


class FaultBias(Strict):
    type: Literal["bias_step"]
    biasSI: FiniteFloat


class FaultDrift(Strict):
    type: Literal["drift"]
    rateSIPerS: FiniteFloat


class FaultStuck(Strict):
    type: Literal["stuck"]


class FaultNoise(Strict):
    type: Literal["noise_increase"]
    factor: PosFloat


class FaultDropout(Strict):
    type: Literal["dropout"]
    probability: Annotated[float, Field(ge=0, lt=1)]


SensorFault = Annotated[Union[FaultBias, FaultDrift, FaultStuck, FaultNoise, FaultDropout], Field(discriminator="type")]


class SensorFaultEvent(Strict):
    kind: Literal["sensor_fault"]
    eventId: Identifier
    sensorId: Identifier
    startTimeS: NonNegFloat
    endTimeS: Optional[NonNegFloat] = None
    fault: SensorFault


class InletChangeEvent(Strict):
    kind: Literal["inlet_change"]
    eventId: Identifier
    nodeId: Identifier
    startTimeS: NonNegFloat
    rampDurationS: NonNegFloat
    temperatureK: Optional[PosFloat] = None
    waterMassFraction: Optional[Annotated[float, Field(ge=0, le=1)]] = None


class AmbientChangeEvent(Strict):
    kind: Literal["ambient_change"]
    eventId: Identifier
    edgeIds: list[Identifier]
    startTimeS: NonNegFloat
    rampDurationS: NonNegFloat
    ambientTemperatureK: PosFloat


TruthEvent = Annotated[Union[LeakEvent, SensorFaultEvent, InletChangeEvent, AmbientChangeEvent], Field(discriminator="kind")]


class ProcessNoise(Strict):
    boundaryPressureStdPa: NonNegFloat
    boundaryPressureTimeConstantS: NonNegFloat
    sourceFlowRelStd: NonNegFloat
    sourceFlowTimeConstantS: NonNegFloat


class PropertyDeviation(Strict):
    viscosityFactor: PosFloat
    bulkModulusFactor: PosFloat
    roughnessFactor: PosFloat


class TruthConfig(Strict):
    schemaVersion: str
    seed: Annotated[int, Field(ge=0, le=2**32 - 1)]
    events: list[TruthEvent] = Field(max_length=100)
    processNoise: ProcessNoise
    propertyDeviation: PropertyDeviation


class ScenarioFile(Strict):
    schemaVersion: str
    id: Identifier
    name: str
    description: str
    expectedBehavior: str
    limitations: list[str]
    tags: list[str]
    public: PublicScenarioConfig
    truth: TruthConfig


# ----------------------------------------------------------------------------- measurements / diagnoses


class MeasurementSample(Strict):
    runId: Identifier
    sequence: Annotated[int, Field(ge=0)]
    sensorId: Identifier
    simTimeS: NonNegFloat
    receivedAt: Optional[FiniteFloat] = None
    valueSI: Optional[FiniteFloat] = None
    quality: Literal["good", "missing", "stale", "saturated", "invalid"]
    unit: str
    measurementKind: Literal["pressure", "temperature", "massFlow", "volumeFlow", "waterFraction"]


class MeasurementPacket(Strict):
    schemaVersion: str
    runId: Identifier
    samples: list[MeasurementSample] = Field(max_length=200_000)


class CandidateEdge(Strict):
    edgeId: Identifier
    misfit: FiniteFloat
    support: Annotated[float, Field(ge=0, le=1)]
    estimatedDistanceM: Optional[NonNegFloat] = None
    intervalM: Optional[tuple[NonNegFloat, NonNegFloat]] = None
    method: Literal["wave_arrival", "steady_residual_fit", "nearest_sensor", "mass_balance_zone"]


class EvidenceItem(Strict):
    code: str
    text: str
    sensorIds: Optional[list[str]] = None
    value: Optional[FiniteFloat] = None


class Diagnosis(Strict):
    schemaVersion: str
    id: str
    detector: Literal["D0", "D1", "D2"]
    detectorVersion: str
    simTimeS: NonNegFloat
    status: Literal["normal", "suspected", "confirmed", "ambiguous", "recovering", "unavailable"]
    cause: Literal["leak", "operating_change", "sensor_fault", "composition_change", "unknown"]
    affectedSensorIds: list[str]
    candidateEdges: list[CandidateEdge]
    estimatedDistanceM: Optional[NonNegFloat] = None
    intervalM: Optional[tuple[NonNegFloat, NonNegFloat]] = None
    estimatedLeakMassFlowKgs: Optional[FiniteFloat] = None
    score: Optional[FiniteFloat] = None
    calibratedProbability: Optional[Annotated[float, Field(ge=0, le=1)]] = None
    causeScores: Optional[dict[str, FiniteFloat]] = None
    evidence: list[EvidenceItem]
    limitations: list[str]
    inputTimeRange: tuple[FiniteFloat, FiniteFloat]
    firstAlarmTimeS: Optional[NonNegFloat] = None
    episodeId: Optional[str] = None


class TruthEventRealization(Strict):
    eventId: str
    kind: Literal["leak", "sensor_fault", "inlet_change", "ambient_change"]
    startTimeS: NonNegFloat
    endTimeS: Optional[NonNegFloat] = None
    edgeId: Optional[str] = None
    requestedDistanceM: Optional[NonNegFloat] = None
    appliedDistanceM: Optional[NonNegFloat] = None
    snapErrorM: Optional[NonNegFloat] = None
    holeDiameterM: Optional[PosFloat] = None
    openingDurationS: Optional[NonNegFloat] = None
    peakLeakMassFlowKgS: Optional[FiniteFloat] = None
    totalLeakMassKg: Optional[FiniteFloat] = None
    sensorId: Optional[str] = None
    nodeId: Optional[str] = None
    detail: Optional[dict] = None


class TerminatedEarly(Strict):
    simTimeS: NonNegFloat
    code: str
    message: str


class GroundTruthRecord(Strict):
    schemaVersion: str
    runId: Identifier
    scenarioId: str
    seed: int
    durationS: NonNegFloat
    events: list[TruthEventRealization]
    normalExposureS: NonNegFloat
    propertyDeviation: PropertyDeviation
    terminatedEarly: Optional[TerminatedEarly] = None


class Calibration(Strict):
    status: Literal["validated", "not_validated"]
    method: Optional[str] = None
    brierValidation: Optional[FiniteFloat] = None
    note: str


class DecisionThresholds(Strict):
    minTopScore: Annotated[float, Field(ge=0, le=1)]


class Parity(Strict):
    goldenFile: str
    maxAbsDiff: NonNegFloat


class LogisticModelArtifact(Strict):
    schemaVersion: str
    modelVersion: str
    featureSchemaVersion: str
    kind: Literal["multinomial_logistic"]
    classes: list[str] = Field(min_length=2)
    featureNames: list[str] = Field(min_length=1)
    scalerMean: list[FiniteFloat]
    scalerScale: list[PosFloat]
    coefficients: list[list[FiniteFloat]]
    intercepts: list[FiniteFloat]
    classMapping: dict[str, str]
    missingFeaturePolicy: Literal["impute_scaler_mean"]
    decisionThresholds: DecisionThresholds
    calibration: Calibration
    trainingMetadata: dict
    evaluationSummary: dict
    parity: Optional[Parity] = None


EXPORTED_SCHEMAS = {
    "public-scenario": PublicScenarioConfig,
    "scenario-file": ScenarioFile,
    "measurement-packet": MeasurementPacket,
    "diagnosis": Diagnosis,
    "ground-truth": GroundTruthRecord,
    "model-artifact": LogisticModelArtifact,
    "fluid-profile": FluidProfile,
}
