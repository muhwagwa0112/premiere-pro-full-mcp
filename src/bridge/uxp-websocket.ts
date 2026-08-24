import { randomUUID, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { BackendAdapter, BackendProbe, BridgeRequest, BridgeResponse, DispatchState, SupportDecision } from "../contracts.js";
import { hasValidEffectiveRequestBinding, routeBindingFromProbe, sameRouteBinding } from "../security/execution-plan.js";
import { loadAdobeApiCatalog } from "../adobe-api-catalog.js";

interface AuthMessage {
  type: "auth";
  protocolVersion: 1;
  token: string;
  hostVersion: string;
  uxpVersion?: string;
  capabilities: string[];
  apiFingerprint: string;
}

interface FileSnapshot {
  size: number;
  mtimeMs: number;
}

interface PendingRequest {
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  request: BridgeRequest;
  outputBaseline: FileSnapshot | null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function fileSnapshot(path: string): Promise<FileSnapshot | null> {
  try {
    const file = await stat(path);
    return file.isFile() ? { size: file.size, mtimeMs: file.mtimeMs } : null;
  } catch {
    return null;
  }
}

async function waitForChangedStableFile(path: string, baseline: FileSnapshot | null, timeoutMs = 5_000, stableObservations = 1): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  let previous: FileSnapshot | null = null;
  let stableCount = 0;
  do {
    const current = await fileSnapshot(path);
    const changed = current && current.size > 0 && (!baseline || current.size !== baseline.size || current.mtimeMs !== baseline.mtimeMs);
    if (changed && previous && current.size === previous.size && current.mtimeMs === previous.mtimeMs) stableCount += 1;
    else stableCount = changed ? 1 : 0;
    if (changed && stableCount >= stableObservations) return current.size;
    previous = changed ? current : null;
    await new Promise((resolve) => setTimeout(resolve, stableObservations > 1 ? 500 : 100));
  } while (Date.now() < deadline);
  return null;
}

export class UxpWebSocketAdapter implements BackendAdapter {
  readonly backend = "uxp" as const;
  readonly #token: string | null;
  readonly #port: number;
  readonly #pending = new Map<string, PendingRequest>();
  #server: WebSocketServer | null = null;
  #socket: WebSocket | null = null;
  #hostVersion: string | null = null;
  #hostSessionId: string | null = null;
  #sequenceExportInFlight: string | null = null;
  #capabilities = new Set<string>();
  #apiFingerprint: string | null = null;
  readonly #unauthenticated = new Set<WebSocket>();
  readonly #failedAuthByAddress = new Map<string, number[]>();

  constructor(token = process.env.PREMIERE_MCP_UXP_TOKEN ?? null, port = Number.parseInt(process.env.PREMIERE_MCP_UXP_PORT ?? "17777", 10)) {
    this.#token = token && token.length >= 24 ? token : null;
    this.#port = Number.isInteger(port) && port > 1024 && port < 65536 ? port : 17777;
  }

  async start(): Promise<void> {
    if (!this.#token || this.#server) return;
    this.#apiFingerprint = (await loadAdobeApiCatalog()).fingerprint;
    await new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({
        host: "127.0.0.1",
        port: this.#port,
        path: "/uxp",
        maxPayload: 1024 * 1024,
        verifyClient: ({ origin }, done) => done(this.isAllowedOrigin(origin), 403, "Browser origins are not allowed"),
      });
      this.#server = server;
      server.once("listening", resolve);
      server.once("error", reject);
      server.on("connection", (socket, request) => this.handleConnection(socket, request));
    });
  }

  async probe(): Promise<BackendProbe> {
    const base = { backend: this.backend, operations: [...this.#capabilities].sort() } as const;
    if (!this.#token) return { ...base, available: false, reason: "PREMIERE_MCP_UXP_TOKEN is not configured with at least 24 characters" };
    if (!this.#server) return { ...base, available: false, reason: "UXP listener is not started" };
    if (!this.#socket || this.#socket.readyState !== this.#socket.OPEN) return { ...base, available: false, reason: "Authenticated Premiere UXP panel is not connected" };
    return {
      ...base,
      available: true,
      ...(this.#hostVersion ? { hostVersion: this.#hostVersion } : {}),
      ...(this.#hostSessionId ? { hostSessionId: this.#hostSessionId } : {}),
      ...(this.#apiFingerprint ? { capabilityFingerprint: this.#apiFingerprint } : {}),
    };
  }

  async supports(operation: string, _context: Record<string, unknown>): Promise<SupportDecision> {
    return this.#capabilities.has(operation)
      ? { supported: true, state: "implemented_unverified", requiredState: ["authenticated UXP session"] }
      : { supported: false, state: "unsupported", reason: `Authenticated UXP host did not advertise ${operation}` };
  }

  async availability(): Promise<{ available: boolean; reason?: string; hostVersion?: string }> {
    const probe = await this.probe();
    return {
      available: probe.available,
      ...(probe.reason ? { reason: probe.reason } : {}),
      ...(probe.hostVersion ? { hostVersion: probe.hostVersion } : {}),
    };
  }

  async execute(request: BridgeRequest): Promise<BridgeResponse> {
    if (request.routeBinding || request.planHash || request.effectiveRequestDigest) {
      const currentProbe = await this.probe();
      if (!request.routeBinding || !request.planHash || !hasValidEffectiveRequestBinding(request) || !currentProbe.available || !sameRouteBinding(request.routeBinding, routeBindingFromProbe(currentProbe))) return this.failure(request.requestId, "ROUTE_BINDING_DRIFT", "UXP route, plan, or effective request binding is incomplete or changed before websocket send", true, "not_dispatched");
    }
    const availability = await this.probe();
    if (!availability.available || !this.#socket) return this.failure(request.requestId, "UXP_UNAVAILABLE", availability.reason ?? "UXP unavailable", true, "not_dispatched");
    if (!this.#capabilities.has(request.operation)) return this.failure(request.requestId, "UXP_CAPABILITY_UNAVAILABLE", `Connected host did not advertise ${request.operation}`, false, "not_dispatched");
    if (request.operation === "export.sequence" && this.#sequenceExportInFlight) {
      return this.failure(request.requestId, "UXP_SEQUENCE_EXPORT_BUSY", "Another sequence export is still being verified", false, "not_dispatched");
    }
    const outputPath = (request.operation === "export.frame" || request.operation === "export.sequence") && typeof request.args.outputPath === "string"
      ? request.args.outputPath
      : null;
    const outputBaseline = outputPath ? await fileSnapshot(outputPath) : null;
    if (request.operation === "export.sequence" && request.args.overwrite !== true && outputBaseline) {
      return this.failure(request.requestId, "UXP_EXPORT_OUTPUT_EXISTS", "Sequence export refused to overwrite an existing output file", false, "not_dispatched");
    }
    if (request.operation === "export.sequence") this.#sequenceExportInFlight = request.requestId;
    try {
      return await new Promise<BridgeResponse>((resolve, reject) => {
        const timeoutMs = request.operation === "export.sequence" ? 30 * 60_000 : 30_000;
        const timer = setTimeout(() => {
          this.#pending.delete(request.requestId);
          resolve(this.failure(request.requestId, "UXP_TIMEOUT", "Premiere UXP command timed out; it was not retried", false, "unknown"));
        }, timeoutMs);
        this.#pending.set(request.requestId, { resolve, reject, timer, request, outputBaseline });
        try {
          this.#socket?.send(JSON.stringify({ type: "command", ...request }));
        } catch (error) {
          clearTimeout(timer);
          this.#pending.delete(request.requestId);
          reject(error as Error);
        }
      });
    } finally {
      if (this.#sequenceExportInFlight === request.requestId) this.#sequenceExportInFlight = null;
    }
  }

  async close(): Promise<void> {
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve(this.failure(requestId, "UXP_CLOSED", "UXP bridge closed before completion", false, "unknown"));
    }
    this.#pending.clear();
    this.#socket?.close();
    this.#socket = null;
    if (this.#server) await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
    this.#server = null;
    this.#unauthenticated.clear();
    this.#failedAuthByAddress.clear();
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const address = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const recentFailures = (this.#failedAuthByAddress.get(address) ?? []).filter((timestamp) => now - timestamp < 60_000);
    this.#failedAuthByAddress.set(address, recentFailures);
    if (this.#unauthenticated.size >= 4 || recentFailures.length >= 8) {
      socket.close(1013, "Authentication rate limit exceeded");
      return;
    }
    this.#unauthenticated.add(socket);
    let authenticated = false;
    const authTimer = setTimeout(() => {
      this.#unauthenticated.delete(socket);
      socket.close(1008, "Authentication required");
    }, 5_000);
    socket.on("message", async (data) => {
      const messageBytes = Array.isArray(data) ? data.reduce((total, item) => total + item.byteLength, 0) : data.byteLength;
      if (messageBytes > 1024 * 1024) {
        socket.close(1009, "Message too large");
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        socket.close(1003, "Invalid JSON");
        return;
      }
      if (!authenticated) {
        const auth = message as Partial<AuthMessage>;
        if (auth.type !== "auth" || auth.protocolVersion !== 1 || typeof auth.token !== "string" || !this.#token || !constantTimeEqual(auth.token, this.#token)) {
          recentFailures.push(Date.now());
          this.#failedAuthByAddress.set(address, recentFailures);
          this.#unauthenticated.delete(socket);
          socket.close(1008, "Authentication failed");
          return;
        }
        if (!Array.isArray(auth.capabilities) || typeof auth.hostVersion !== "string" || typeof auth.apiFingerprint !== "string") {
          socket.close(1008, "Invalid capability handshake");
          return;
        }
        if (!this.#apiFingerprint || auth.apiFingerprint !== this.#apiFingerprint) {
          socket.close(1008, "Adobe API catalog fingerprint mismatch");
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        this.#unauthenticated.delete(socket);
        this.#socket?.close(1012, "Superseded by a new authenticated panel");
        this.#socket = socket;
        this.#hostVersion = auth.hostVersion;
        this.#capabilities = new Set(auth.capabilities.filter((item): item is string => typeof item === "string"));
        this.#hostSessionId = randomUUID();
        socket.send(JSON.stringify({ type: "authenticated", protocolVersion: 1, sessionId: this.#hostSessionId }));
        return;
      }
      const response = message as BridgeResponse & { type?: string };
      if (response.type !== "response" || response.protocolVersion !== 1 || typeof response.requestId !== "string" || typeof response.ok !== "boolean") return;
      const pending = this.#pending.get(response.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(response.requestId);
      const hostVersion = response.hostVersion ?? this.#hostVersion;
      let resolved: BridgeResponse = hostVersion
        ? { ...response, hostVersion, dispatchState: "completed" }
        : { ...response, dispatchState: "completed" };
      if (resolved.ok && (pending.request.operation === "export.frame" || pending.request.operation === "export.sequence")) {
        const outputPath = pending.request.args.outputPath;
        if (typeof outputPath !== "string") {
          resolved = this.failure(response.requestId, "UXP_EXPORT_PATH_INVALID", "Export output path is unavailable for postcondition verification", false, "accepted");
        } else {
          const isSequence = pending.request.operation === "export.sequence";
          const bytes = await waitForChangedStableFile(outputPath, pending.outputBaseline, isSequence ? 30 * 60_000 : 5_000, isSequence ? 20 : 1);
          resolved = bytes === null
            ? this.failure(response.requestId, "UXP_EXPORT_FILE_NOT_VERIFIED", "Premiere accepted export but no changed stable output file was observed", false, "accepted")
            : { ...resolved, createdFiles: [{ name: outputPath, verified: true }], verification: { outcome: "verified", method: `Authenticated Premiere export dispatch and changed stable file readback (${bytes} bytes)` } };
        }
      }
      pending.resolve(resolved);
    });
    socket.on("close", () => {
      clearTimeout(authTimer);
      this.#unauthenticated.delete(socket);
      if (socket !== this.#socket) return;
      this.#socket = null;
      this.#hostVersion = null;
      this.#hostSessionId = null;
      this.#capabilities.clear();
      for (const [requestId, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.resolve(this.failure(requestId, "UXP_DISCONNECTED", "UXP panel disconnected; operation was not replayed", false, "unknown"));
      }
      this.#pending.clear();
    });
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    // Premiere Pro 26.3 identifies UXP panel websocket handshakes with the
    // exact opaque file origin below. Keep the match exact: accepting general
    // file URLs would unnecessarily broaden the local bridge surface.
    if (!origin || origin === "null" || origin === "file://") return true;
    try {
      return new URL(origin).protocol === "uxp:";
    } catch {
      return false;
    }
  }

  private failure(requestId: string, code: string, message: string, retryable: boolean, dispatchState: DispatchState): BridgeResponse {
    return { protocolVersion: 1, requestId, ok: false, dispatchState, error: { code, message, retryable } };
  }
}
