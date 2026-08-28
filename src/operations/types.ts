export type OperationBackend = "cep" | "uxp" | "local";
export type OperationMode = "read" | "mutate" | "local";
export type OperationStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "ACKNOWLEDGED";

export interface HostSessionRef {
  sessionId: string;
  generation?: number;
  version?: string;
}

/** A caller-produced, body-free description of observable project state. */
export interface OperationSnapshot {
  projectionVersion?: number;
  fingerprint: string;
  capturedAt: string;
  projectHash?: string;
  sequenceHash?: string;
  activeSequenceId?: string;
  resolvedSequenceId?: string;
  resolvedSequenceName?: string;
  coverage?: "project" | "timeline" | "clip-components";
  hostSession?: HostSessionRef;
}

export interface PayloadMetadata {
  sha256: string;
  bytes: number;
}

export interface OperationTarget {
  kind: string;
  sha256: string;
  /** Human-readable only for sequence targets; other target hints remain hash-only. */
  label?: string;
}

export interface OperationLedgerEntry {
  schemaVersion: 1;
  operationId: string;
  recordedAt: string;
  toolName: string;
  backend: OperationBackend;
  mode: OperationMode;
  status: OperationStatus;
  target?: OperationTarget;
  args?: PayloadMetadata;
  script?: PayloadMetadata;
  preSnapshot?: OperationSnapshot;
  postSnapshot?: OperationSnapshot;
  hostSession?: HostSessionRef;
  saveAt?: string;
  errorCode?: string;
}

export interface UnknownOperationSummary {
  operationId: string;
  toolName: string;
  backend: OperationBackend;
  target?: OperationTarget;
  preFingerprint?: string;
  preProjectionVersion?: number;
  resolvedSequenceId?: string;
  resolvedSequenceName?: string;
  hostSession?: HostSessionRef;
  recordedAt: string;
}

/** JSON-safe status intended for additive MCP/daemon diagnostics. */
export interface OperationCoordinatorStatus {
  quarantined: boolean;
  unresolved: UnknownOperationSummary[];
  cepQueueDepth: number;
  mutationQueueDepth: number;
}

export type ReconnectComparison = "BOUNDED_MATCH" | "CHANGED_FROM_PRE" | "INCOMPARABLE_PROJECTION" | "NO_PRE_SNAPSHOT";

export class OperationQueueDeadlineError extends Error {
  readonly code = "OPERATION_QUEUE_DEADLINE";
  constructor(message = "Operation expired while waiting for an execution lease") {
    super(message);
    this.name = "OperationQueueDeadlineError";
  }
}

export class OperationExecutionUnknownError extends Error {
  readonly code = "OPERATION_OUTCOME_UNKNOWN";
  readonly operationId: string;
  constructor(operationId: string, message: string) {
    super(message);
    this.name = "OperationExecutionUnknownError";
    this.operationId = operationId;
  }
}

export class MutationQuarantinedError extends Error {
  readonly code = "MUTATIONS_QUARANTINED";
  constructor() {
    super("Mutations are quarantined until every unknown operation is explicitly acknowledged");
    this.name = "MutationQuarantinedError";
  }
}

export class OperationIdReusedError extends Error {
  readonly code = "OPERATION_ID_REUSED";
  constructor(operationId: string) {
    super(`Operation id '${operationId}' already exists in the durable ledger`);
    this.name = "OperationIdReusedError";
  }
}
