import { randomUUID, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { BackendAdapter, BridgeRequest, BridgeResponse } from "../contracts.js";
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

interface PendingRequest {
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  request: BridgeRequest;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function waitForNonEmptyFile(path: string, timeoutMs = 5_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const file = await stat(path);
      if (file.isFile() && file.size > 0) return file.size;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
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

  async availability(): Promise<{ available: boolean; reason?: string; hostVersion?: string }> {
    if (!this.#token) return { available: false, reason: "PREMIERE_MCP_UXP_TOKEN is not configured with at least 24 characters" };
    if (!this.#server) return { available: false, reason: "UXP listener is not started" };
    if (!this.#socket || this.#socket.readyState !== this.#socket.OPEN) return { available: false, reason: "Authenticated Premiere UXP panel is not connected" };
    return this.#hostVersion ? { available: true, hostVersion: this.#hostVersion } : { available: true };
  }

  async execute(request: BridgeRequest): Promise<BridgeResponse> {
    const availability = await this.availability();
    if (!availability.available || !this.#socket) return this.failure(request.requestId, "UXP_UNAVAILABLE", availability.reason ?? "UXP unavailable", true);
    if (!this.#capabilities.has(request.operation)) return this.failure(request.requestId, "UXP_CAPABILITY_UNAVAILABLE", `Connected host did not advertise ${request.operation}`, false);
    return new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.requestId);
        resolve(this.failure(request.requestId, "UXP_TIMEOUT", "Premiere UXP command timed out; it was not retried", true));
      }, 30_000);
      this.#pending.set(request.requestId, { resolve, reject, timer, request });
      try {
        this.#socket?.send(JSON.stringify({ type: "command", ...request }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(request.requestId);
        reject(error as Error);
      }
    });
  }

  async close(): Promise<void> {
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve(this.failure(requestId, "UXP_CLOSED", "UXP bridge closed before completion", true));
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
        socket.send(JSON.stringify({ type: "authenticated", protocolVersion: 1, sessionId: randomUUID() }));
        return;
      }
      const response = message as BridgeResponse & { type?: string };
      if (response.type !== "response" || response.protocolVersion !== 1 || typeof response.requestId !== "string" || typeof response.ok !== "boolean") return;
      const pending = this.#pending.get(response.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(response.requestId);
      const hostVersion = response.hostVersion ?? this.#hostVersion;
      let resolved = hostVersion ? { ...response, hostVersion } : response;
      if (resolved.ok && pending.request.operation === "export.frame") {
        const outputPath = pending.request.args.outputPath;
        if (typeof outputPath !== "string") {
          resolved = this.failure(response.requestId, "UXP_FRAME_PATH_INVALID", "Frame output path is unavailable for postcondition verification", false);
        } else {
          const bytes = await waitForNonEmptyFile(outputPath);
          resolved = bytes === null
            ? this.failure(response.requestId, "UXP_FRAME_FILE_NOT_VERIFIED", "Premiere confirmed export but no non-empty output file was observed", false)
            : { ...resolved, createdFiles: [{ name: outputPath, verified: true }], verification: { outcome: "verified", method: `Exporter response and non-empty file readback (${bytes} bytes)` } };
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
      this.#capabilities.clear();
      for (const [requestId, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.resolve(this.failure(requestId, "UXP_DISCONNECTED", "UXP panel disconnected; operation was not replayed", true));
      }
      this.#pending.clear();
    });
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin || origin === "null") return true;
    try {
      return new URL(origin).protocol === "uxp:";
    } catch {
      return false;
    }
  }

  private failure(requestId: string, code: string, message: string, retryable: boolean): BridgeResponse {
    return { protocolVersion: 1, requestId, ok: false, error: { code, message, retryable } };
  }
}
