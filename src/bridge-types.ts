/**
 * Wire contract between the MCP server (Node), the always-on bridge daemon,
 * and the Premiere CEP host.
 *
 * Local-first: no auth, no signatures, no nonces, no session tokens.
 *
 * The daemon is a small loopback WebSocket router that stays up permanently
 * (installed to auto-start at logon). Two kinds of clients connect to it:
 *
 *   1. The Premiere CEP extension — announces with kind:"ready", receives
 *      kind:"execute" messages carrying an ExtendScript string, runs it via
 *      CSInterface.evalScript (callback), and replies kind:"response".
 *   2. MCP servers — send kind:"execute" messages; the daemon forwards them
 *      to the CEP host and relays the reply back to the requesting MCP client.
 *
 * This is a strict request/response relay, one script per request.
 */

/** Message a client (MCP server) sends to ask the host to run a script. */
export interface ExecuteRequest {
  kind: "execute";
  requestId: string;
  /** Full ExtendScript source (already wrapped to return a JSON string). */
  script: string;
  /** Optional execution budget in ms. The CEP host honours it per call. */
  timeoutMs?: number;
  /** Optional caller context for diagnostics/recovery. It never affects routing. */
  operation?: OperationWireMetadata;
}

export interface OperationWireMetadata extends Record<string, unknown> {
  operationId: string;
  toolName?: string;
  backend?: "cep" | "uxp";
  mode?: "read" | "mutate";
  scriptSha256?: string;
  scriptBytes?: number;
}

export interface BeginOperationWireRequest {
  kind: "begin_operation";
  requestId: string;
  operationId?: string;
  toolName: string;
  backend: "cep" | "uxp";
  mode: "read" | "mutate";
  targetHint?: string;
  targetKind?: string;
  timeoutMs?: number;
  queueDeadlineMs?: number;
  args?: unknown;
  itemCount?: number;
  estimatedRiskyCalls?: number;
}

export interface EndOperationWireRequest {
  kind: "end_operation";
  requestId: string;
  operationId: string;
  status: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  failureCode?: string;
}

export interface OperationStatusWireRequest {
  kind: "operation_status";
  requestId: string;
}

export interface AcknowledgeRecoveryWireRequest {
  kind: "acknowledge_recovery";
  requestId: string;
  operationId: string;
  expectedFingerprint: string;
}

/** Read the current bounded snapshot for one unresolved mutation before acknowledgement. */
export interface RecoverySnapshotWireRequest {
  kind: "recovery_snapshot";
  requestId: string;
  operationId: string;
}

/** A lightweight evalScript round-trip used to prove the CEP/UI thread responds. */
export interface HostProbeRequest {
  kind: "host_probe";
  requestId: string;
  timeoutMs?: number;
}

/** A read-only Premiere DOM probe, deliberately distinct from transport health. */
export interface DomReadinessProbeRequest {
  kind: "dom_readiness_probe";
  requestId: string;
  timeoutMs?: number;
}

/** Message the CEP host sends to answer an ExecuteRequest. */
export interface ExecuteResponse {
  kind: "response";
  requestId: string;
  ok: boolean;
  /** Raw result produced by evalScript (usually a JSON string). */
  data?: unknown;
  operation?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    /** True when Premiere may have applied some or all of the timed-out operation. */
    outcomeUnknown?: boolean;
  };
}

/** A timed-out evalScript callback eventually completed; this is diagnostic, not a retry. */
export interface LateCompletionMessage {
  kind: "late_completion";
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: ExecuteResponse["error"];
  operation?: Record<string, unknown>;
}

/** Message the CEP host sends upon (re)connecting. */
export const APPROVED_CEP_EXTENSION_ID = "com.codex.premiere-pro-full-mcp.cep.headless";
export const CEP_BRIDGE_PROTOCOL_VERSION = 1;

export interface CepBridgeIdentity {
  extensionId: string;
  protocolVersion: number;
  /** Version declared by the installed CEP bundle, when the runtime can read it. */
  bridgeVersion?: string;
  /** Unique to one loaded CEP JavaScript runtime, not one WebSocket reconnect. */
  instanceId: string;
}

export interface ReadyMessage {
  kind: "ready";
  identity: CepBridgeIdentity;
  /** Premiere Pro host version, deliberately separate from bridge provenance. */
  premiereVersion?: string;
}

export interface HostSession {
  /** @deprecated Use premiereVersion. Retained for existing MCP clients. */
  version?: string;
  premiereVersion?: string;
  identity?: CepBridgeIdentity;
  sessionId: string;
  generation: number;
}

export interface HostProbeResult extends HostSession {
  connected: true;
  responsive: true;
}

export interface DomReadinessProbeResult extends HostSession {
  transportResponsive: true;
  domReady: true;
  projectOpen: boolean;
  projectName: string | null;
  activeSequence: { id: string | null; name: string | null } | null;
}

export interface DomReadinessStatus {
  lastCheckedAt: string | null;
  lastSuccessfulAt: string | null;
  domReady: boolean | null;
  errorCode: string | null;
  consecutiveSuccesses: number;
  sessionId: string | null;
  generation: number | null;
}

/** Message the daemon sends to a ready CEP host. */
export interface HelloMessage {
  kind: "hello";
  ok: true;
  port: number;
  host?: HostSession;
}

export interface RejectedHelloMessage {
  kind: "hello";
  ok: false;
  error: {
    code: "CEP_HOST_REJECTED";
    message: string;
    expectedExtensionId: string;
    expectedProtocolVersion: number;
  };
}

export type BridgeMessage =
  | ExecuteRequest
  | HostProbeRequest
  | DomReadinessProbeRequest
  | BeginOperationWireRequest
  | EndOperationWireRequest
  | OperationStatusWireRequest
  | AcknowledgeRecoveryWireRequest
  | RecoverySnapshotWireRequest
  | ExecuteResponse
  | LateCompletionMessage
  | ReadyMessage
  | HelloMessage
  | RejectedHelloMessage;

export const DEFAULT_EXECUTION_TIMEOUT_MS = 300_000;
export const MIN_EXECUTION_TIMEOUT_MS = 250;
export const MAX_EXECUTION_TIMEOUT_MS = 300_000;

/** Keep every relay layer on the same finite, bounded execution budget. */
export function normalizeExecutionTimeout(value: unknown, fallback = DEFAULT_EXECUTION_TIMEOUT_MS): number {
  const fallbackNumber = typeof fallback === "number" && Number.isFinite(fallback)
    ? Math.trunc(fallback)
    : DEFAULT_EXECUTION_TIMEOUT_MS;
  const normalizedFallback = Math.min(MAX_EXECUTION_TIMEOUT_MS, Math.max(MIN_EXECUTION_TIMEOUT_MS, fallbackNumber));
  if (typeof value !== "number" || !Number.isFinite(value)) return normalizedFallback;
  return Math.min(MAX_EXECUTION_TIMEOUT_MS, Math.max(MIN_EXECUTION_TIMEOUT_MS, Math.trunc(value)));
}

/** Information the daemon writes once so every client can find the port. */
export interface BridgeEndpoint {
  port: number;
  host: "127.0.0.1";
  protocol: "ws";
}
