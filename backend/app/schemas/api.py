from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from .domain import Identifier


class ApiError(BaseModel):
    code: str
    message: str
    fieldPath: Optional[str] = None
    details: Optional[dict] = None


class ValidationIssueOut(BaseModel):
    code: str
    message: str
    fieldPath: Optional[str] = None


class ValidationResponse(BaseModel):
    ok: bool
    errors: list[ValidationIssueOut]
    warnings: list[ValidationIssueOut]


class Health(BaseModel):
    status: Literal["ok"]
    version: str
    storage: bool
    runner: bool
    modelRegistry: bool
    schemaVersion: str


class ScenarioMeta(BaseModel):
    id: str
    name: str
    tags: list[str]
    configHash: str
    createdAt: float
    source: Literal["bundled", "saved"]


class RunCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    runId: Identifier
    scenarioId: Optional[Identifier] = None
    configHash: Optional[str] = Field(default=None, max_length=128)
    versions: dict[str, str] = Field(default_factory=dict)


class RunOut(BaseModel):
    id: str
    scenarioId: Optional[str]
    configHash: Optional[str]
    versions: dict
    status: str
    createdAt: float
    finishedAt: Optional[float] = None


class BatchAck(BaseModel):
    runId: str
    batchKey: str
    accepted: int
    duplicate: bool


class DatasetJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    datasetId: Identifier
    count: int = Field(ge=1, le=2000)
    seed: int = Field(ge=0, le=2**31 - 1)
    spec: Literal["default", "ood", "heldout", "lowrate"] = "default"


class TrainJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    trainDatasetId: Identifier
    validationDatasetId: Identifier
    modelId: Identifier


class EvaluateJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    datasetId: Identifier
    modelId: Identifier


class JobOut(BaseModel):
    id: str
    kind: str
    params: dict
    status: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    progress: float
    message: Optional[str] = None
    result: Optional[dict] = None
    createdAt: float
    updatedAt: float


class ModelOut(BaseModel):
    id: str
    modelVersion: Optional[str]
    featureSchemaVersion: Optional[str]
    classes: Optional[list[str]]
    calibration: Optional[str]
    parityMaxAbsDiff: Optional[float]
    validationStatus: str
    evaluationSummary: Optional[dict]
