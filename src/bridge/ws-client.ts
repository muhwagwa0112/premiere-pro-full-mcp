import { createHash, randomUUID } from "node:crypto";
import { wrapCepEvalScript } from "./cep-script.js";
import WebSocket from "ws";
import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  MAX_EXECUTION_TIMEOUT_MS,
  normalizeExecutionTimeout,
  type DomReadinessProbeResult,
  type ExecuteResponse,
  type HostProbeResult,
  type HostSession,
  type LateCompletionMessage,
  type OperationWireMetadata,
} from "../bridge-types.js";
import type { BeginOperationRequest } from "../operations/coordinator.js";
import type { OperationCoordinatorStatus, OperationStatus, ReconnectComparison } from "../operations/types.js";
import { DEFAULT_DAEMON_PORT, readBridgeEndpoint } from "./ws-host.js";

/**
 * Loopback WebSocket client that an MCP server uses to reach the always-on
 * bridge daemon. Every tool execution is one `execute` request carrying the
 * full ExtendScript; the daemon relays it to the CEP host and returns the
 * response. No auth, no polling — a single persistent connection.
 *
 * This is also the `transport` object passed to the upstream tool catalog:
 * upstream handlers call `transport.executeScript(script)`.
 */
export class BridgeClient {
  readonly #port: number;
  #ws: WebSocket | null = null;
  #pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      outcomeUnknown: boolean;
      operation?: Record<string, unknown>;
    }
  >();
  #connecting: Promise<void> | null = null;
  #hostSession: HostSession | null = null;
  #lateCompletionListeners = new Set<(message: LateCompletionMessage) => void>();

  constructor(port: number) {
    this.#port = port;
  }

  /** Create a client from the published endpoint, or to a known port. */
  static async connect(endpoint?: { port: number } | number): Promise<BridgeClient> {
    let port: number;
    if (typeof endpoint === "number") port = endpoint;
    else if (endpoint) port = endpoint.port;
    else {
      const stored = readBridgeEndpoint();
      port = stored ? stored.port : DEFAULT_DAEMON_PORT;
    }
    const client = new BridgeClient(port);
    await client.#open();
    return client;
  }

  async #open(): Promise<void> {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.#port}/bridge`);
      this.#ws = ws;
      let connectionSettled = false;
      ws.on("open", () => {
        this.#ws = ws;
        connectionSettled = true;
        resolve();
      });
      ws.on("error", (error) => {
        if (!connectionSettled) {
          connectionSettled = true;
          reject(error);
        }
      });
      ws.on("message", (raw) => this.#onMessage(raw));
      ws.on("close", () => {
        if (this.#ws === ws) this.#ws = null;
        this.#connecting = null;
        if (!connectionSettled) {
          connectionSettled = true;
          reject(new Error("Bridge connection closed before it opened"));
        }
        this.#rejectAll(new Error("Bridge connection closed before the host responded"), "BRIDGE_DISCONNECTED");
      });
    });
    try {
      await this.#connecting;
    } finally {
      this.#connecting = null;
    }
  }

  #rejectAll(error: Error, code: string): void {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(entry.outcomeUnknown
        ? new BridgeExecutionError(error.message, {
            code,
            retryable: false,
            outcomeUnknown: true,
            ...(entry.operation === undefined ? {} : { operation: entry.operation }),
          })
        : error);
    }
  }

  async #request(
    message: Record<string, unknown>,
    timeoutMs: number,
    timeoutMessage: string,
    options: { outcomeUnknown?: boolean; operation?: Record<string, unknown> } = {},
  ): Promise<unknown> {
    await this.#open();
    const requestId = String(message.requestId);
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("Bridge connection is not open");
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(options.outcomeUnknown
          ? new BridgeExecutionError(timeoutMessage, {
              code: "BRIDGE_RESPONSE_TIMEOUT",
              retryable: false,
              outcomeUnknown: true,
              ...(options.operation === undefined ? {} : { operation: options.operation }),
            })
          : new Error(timeoutMessage));
      }, timeoutMs + 1_000);
      this.#pending.set(requestId, {
        resolve,
        reject,
        timer,
        outcomeUnknown: options.outcomeUnknown === true,
        ...(options.operation === undefined ? {} : { operation: options.operation }),
      });
      ws.send(JSON.stringify(message), (error) => {
        if (!error) return;
        const entry = this.#pending.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.#pending.delete(requestId);
        entry.reject(error);
      });
    });
  }

  #onMessage(raw: WebSocket.RawData): void {
    let msg: ExecuteResponse | LateCompletionMessage | { kind: "hello"; host?: HostSession };
    try {
      msg = JSON.parse(raw.toString()) as ExecuteResponse | LateCompletionMessage | { kind: "hello"; host?: HostSession };
    } catch {
      return;
    }
    if (msg.kind === "hello") {
      if (msg.host) this.#hostSession = msg.host;
      return;
    }
    if (msg.kind === "late_completion") {
      for (const listener of this.#lateCompletionListeners) listener(msg);
      return;
    }
    const entry = this.#pending.get(msg.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#pending.delete(msg.requestId);
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(new BridgeExecutionError(msg.error?.message ?? "Bridge execution failed", {
      ...(msg.error?.code === undefined ? {} : { code: msg.error.code }),
      ...(msg.error?.retryable === undefined ? {} : { retryable: msg.error.retryable }),
      ...(msg.error?.outcomeUnknown === undefined ? {} : { outcomeUnknown: msg.error.outcomeUnknown }),
      ...(msg.operation === undefined ? {} : { operation: msg.operation }),
    }));
  }

  /**
   * Execute a full ExtendScript and return the parsed result.
   * This is the `transport.executeScript` surface upstream handlers expect:
   * they await it and normalize the returned { success, data|error } shape
   * downstream.
   */
  async executeScript(
    script: string,
    timeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS,
    operation?: OperationWireMetadata,
  ): Promise<unknown> {
    const budget = normalizeExecutionTimeout(timeoutMs);
    const requestId = randomUUID();
    // Upstream scripts arrive as `return (function(){...})();`. ExtendScript
    // rejects a top-level `return` (ES3 has no module scope), so we wrap the
    // whole payload in an IIFE exactly like the official bridge does. The
    // inner `return` becomes the outer function's return value, which CEP's
    // evalScript callback delivers.
    const wrapped = wrapCepEvalScript(script);
    const wireOperation = operation && operation.toolName && operation.backend && operation.mode
      ? {
          ...operation,
          scriptSha256: createHash("sha256").update(wrapped, "utf8").digest("hex"),
          scriptBytes: Buffer.byteLength(wrapped, "utf8"),
        }
      : operation;
    return await this.#request(
      { kind: "execute", requestId, script: wrapped, timeoutMs: budget, operation: wireOperation },
      budget,
      `Premiere host execution timed out after ${budget}ms`,
      { outcomeUnknown: true, ...(wireOperation === undefined ? {} : { operation: wireOperation }) },
    );
  }

  /** Prove that the CEP panel and Premiere evalScript callback are responsive. */
  async probeHost(timeoutMs = 5_000): Promise<HostProbeResult> {
    const budget = normalizeExecutionTimeout(timeoutMs, 5_000);
    const requestId = randomUUID();
    const result = await this.#request(
      { kind: "host_probe", requestId, timeoutMs: budget },
      budget,
      `Premiere host probe timed out after ${budget}ms`,
    );
    const probe = result as HostProbeResult;
    this.#hostSession = {
      sessionId: probe.sessionId,
      generation: probe.generation,
      ...(probe.version === undefined ? {} : { version: probe.version }),
      ...(probe.premiereVersion === undefined ? {} : { premiereVersion: probe.premiereVersion }),
      ...(probe.identity === undefined ? {} : { identity: { ...probe.identity } }),
    };
    return probe;
  }

  /** Prove that Premiere's project DOM can be read, separately from transport health. */
  async probeDomReadiness(timeoutMs = 5_000): Promise<DomReadinessProbeResult> {
    const budget = normalizeExecutionTimeout(timeoutMs, 5_000);
    const requestId = randomUUID();
    const result = await this.#request(
      { kind: "dom_readiness_probe", requestId, timeoutMs: budget },
      budget,
      `Premiere DOM readiness probe timed out after ${budget}ms`,
    );
    const probe = result as DomReadinessProbeResult;
    this.#hostSession = {
      sessionId: probe.sessionId,
      generation: probe.generation,
      ...(probe.version === undefined ? {} : { version: probe.version }),
      ...(probe.premiereVersion === undefined ? {} : { premiereVersion: probe.premiereVersion }),
      ...(probe.identity === undefined ? {} : { identity: { ...probe.identity } }),
    };
    return probe;
  }

  /**
   * Dispatch a UXP operation to the connected UXP panel through the daemon.
   * Returns the model's normalized { success, data|error } object. This is the
   * second track used by tools that can only run over the UXP bridge.
   */
  async uxp(
    operation: string,
    args: Record<string, unknown> = {},
    expectedRevision?: string,
    operationMetadata?: OperationWireMetadata,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const requestId = randomUUID();
    const budget = normalizeExecutionTimeout(timeoutMs, 30_000);
    return await this.#request(
      { kind: "uxp", requestId, operation, args, expectedRevision, timeoutMs: budget, operationMetadata },
      budget,
      "Premiere UXP host execution timed out",
      { outcomeUnknown: operationMetadata !== undefined, ...(operationMetadata === undefined ? {} : { operation: operationMetadata }) },
    );
  }

  async beginOperation(request: Omit<BeginOperationRequest, "script" | "hostSession">): Promise<string> {
    const requestId = randomUUID();
    const queueBudget = typeof request.queueDeadlineMs === "number" && Number.isFinite(request.queueDeadlineMs)
      ? Math.max(0, Math.trunc(request.queueDeadlineMs))
      : 30_000;
    const requestBudget = Math.min(
      MAX_EXECUTION_TIMEOUT_MS - 1_000,
      queueBudget + 5_000,
    );
    const result = await this.#request(
      { kind: "begin_operation", requestId, ...request },
      requestBudget,
      "Timed out while beginning the Premiere operation",
    ) as { operationId: string };
    return result.operationId;
  }

  async endOperation(
    operationId: string,
    status: Extract<OperationStatus, "SUCCEEDED" | "FAILED" | "UNKNOWN">,
    failureCode?: string,
  ): Promise<Extract<OperationStatus, "SUCCEEDED" | "FAILED" | "UNKNOWN">> {
    const requestId = randomUUID();
    const result = await this.#request(
      { kind: "end_operation", requestId, operationId, status, failureCode },
      MAX_EXECUTION_TIMEOUT_MS - 1_000,
      "Timed out while ending the Premiere operation",
    ) as { status: Extract<OperationStatus, "SUCCEEDED" | "FAILED" | "UNKNOWN"> };
    return result.status;
  }

  async operationStatus(): Promise<OperationCoordinatorStatus & Record<string, unknown>> {
    const requestId = randomUUID();
    return await this.#request(
      { kind: "operation_status", requestId },
      5_000,
      "Timed out while reading Premiere operation status",
    ) as OperationCoordinatorStatus & Record<string, unknown>;
  }

  async acknowledgeRecovery(operationId: string, expectedFingerprint: string): Promise<{ operationId: string; observedFingerprint: string }> {
    const requestId = randomUUID();
    return await this.#request(
      { kind: "acknowledge_recovery", requestId, operationId, expectedFingerprint },
      10_000,
      "Timed out while acknowledging Premiere recovery",
    ) as { operationId: string; observedFingerprint: string };
  }

  /** Capture and compare the current bounded recovery projection without changing quarantine state. */
  async recoverySnapshot(operationId: string): Promise<{ operationId: string; observedFingerprint: string; projectionVersion?: number; comparison: ReconnectComparison }> {
    const requestId = randomUUID();
    return await this.#request(
      { kind: "recovery_snapshot", requestId, operationId },
      30_000,
      "Timed out while reading Premiere recovery snapshot",
    ) as { operationId: string; observedFingerprint: string; projectionVersion?: number; comparison: ReconnectComparison };
  }

  get connected(): boolean {
    return this.#ws !== null && this.#ws.readyState === WebSocket.OPEN;
  }

  get port(): number {
    return this.#port;
  }

  get hostSession(): HostSession | null {
    return this.#hostSession ? { ...this.#hostSession } : null;
  }

  onLateCompletion(listener: (message: LateCompletionMessage) => void): () => void {
    this.#lateCompletionListeners.add(listener);
    return () => this.#lateCompletionListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.#rejectAll(new Error("Bridge client closed before the host responded"), "BRIDGE_CLIENT_CLOSED");
    if (this.#ws && (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING)) {
      this.#ws.close();
    }
    this.#ws = null;
    this.#hostSession = null;
  }
}

export class BridgeExecutionError extends Error {
  readonly code?: string;
  readonly retryable?: boolean;
  readonly outcomeUnknown?: boolean;
  readonly operation?: Record<string, unknown>;

  constructor(message: string, details: {
    code?: string;
    retryable?: boolean;
    outcomeUnknown?: boolean;
    operation?: Record<string, unknown>;
  } = {}) {
    super(message);
    this.name = "BridgeExecutionError";
    if (details.code !== undefined) this.code = details.code;
    if (details.retryable !== undefined) this.retryable = details.retryable;
    if (details.outcomeUnknown !== undefined) this.outcomeUnknown = details.outcomeUnknown;
    if (details.operation !== undefined) this.operation = details.operation;
  }
}
