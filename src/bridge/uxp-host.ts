import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";

/**
 * UXP bridge host (the second track of the dual-track CEP+UXP architecture).
 *
 * Premiere 26.x exposes several high-value edit/export APIs (SequenceEditor
 * createRemoveItemsAction, createCloneTrackItemAction, createMoveAction,
 * createInsertProjectItemAction, Exporter.exportSequenceFrame, and a large
 * typed member catalog) that are only reachable from a UXP panel, not over
 * CEP/ExtendScript. This host serves the same HMAC-authenticated `/uxp`
 * WebSocket protocol the bundled UXP panel already speaks, so the daemon can
 * route those operations to the UXP panel and back to the MCP server.
 *
 * Protocol (mirrors the panel's main.cjs connect()):
 *   1. client -> { type:"hello", protocolVersion:3, authFilePath, clientNonce,
 *      apiFingerprint }
 *   2. server -> { type:"challenge", protocolVersion:3, serverNonce, serverProof }
 *   3. client -> { type:"connect", protocolVersion:3, clientProof, hostVersion,
 *      capabilities, apiFingerprint }
 *   4. server -> { type:"connected", protocolVersion:3, sessionId }
 *   5. server -> { type:"command", requestId, operation, args, sessionId }
 *   6. client -> { type:"response", protocolVersion:1, requestId, ok, result/error }
 *
 * The MCP server calls `dispatch(operation, args, sessionId)` which routes the
 * single request to the connected UXP panel and resolves with the panel reply.
 */

const AUTH_FILE_NAME = "premiere-mcp-bridge-key-v1";
export const BRIDGE_SETTINGS_FILE_NAME = "bridge-settings-v1.json";
export const UXP_DEFAULT_PORT = 17777;

function ascii(value: string): Buffer {
  for (const ch of value) if (ch.charCodeAt(0) > 0x7f) throw new Error("Authentication transcript must be ASCII");
  return Buffer.from(value, "ascii");
}

function authenticationTranscript(role: "client" | "server", clientNonce: string, serverNonce: string, apiFingerprint: string): string {
  if (!/^[a-f0-9]{64}$/.test(clientNonce) || !/^[a-f0-9]{64}$/.test(serverNonce) || !/^[a-f0-9]{64}$/.test(apiFingerprint)) {
    throw new Error("Invalid authentication transcript");
  }
  return `premiere-mcp-uxp-v3\n${role}\n${clientNonce}\n${serverNonce}\n${apiFingerprint}`;
}

function authenticationProof(secret: string, role: "client" | "server", clientNonce: string, serverNonce: string, apiFingerprint: string): string {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(ascii(authenticationTranscript(role, clientNonce, serverNonce, apiFingerprint))).digest("hex");
}

function sameHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/** Resolution for the auth key that both the panel and this host read. */
function uxpAuthRoot(): string {
  const base = process.env.APPDATA
    ? join(process.env.APPDATA, "Adobe", "UXP", "PluginsStorage", "PPRO", "26", "External", "com.codex.premiere-pro-full-mcp", "PluginData")
    : join(tmpdir(), "PremiereMCP");
  mkdirSync(base, { recursive: true });
  return base;
}

function uxpAuthFilePath(): string {
  return join(uxpAuthRoot(), AUTH_FILE_NAME);
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class UxpBridgeHost {
  readonly #http: HttpServer;
  readonly #wss: WebSocketServer;
  readonly #port: number;
  readonly #apiFingerprint: string;
  readonly #authSecret: string;
  #socket: WebSocket | null = null;
  #sessionId: string | null = null;
  #hostVersion: string | null = null;
  #capabilities: Set<string> = new Set();
  #pending = new Map<string, PendingRequest>();

  private constructor(http: HttpServer, wss: WebSocketServer, port: number, apiFingerprint: string, authSecret: string) {
    this.#http = http;
    this.#wss = wss;
    this.#port = port;
    this.#apiFingerprint = apiFingerprint;
    this.#authSecret = authSecret;
  }

  static async start(options: { port?: number; apiFingerprint: string; authSecret: string } = { port: UXP_DEFAULT_PORT, apiFingerprint: "", authSecret: "" }): Promise<UxpBridgeHost> {
    const requestedPort = options.port ?? UXP_DEFAULT_PORT;
    const port = Number.isInteger(requestedPort) && requestedPort > 1024 && requestedPort < 65536 ? requestedPort : UXP_DEFAULT_PORT;
    const http = createHttpServer();
    const wss = new WebSocketServer({ server: http, path: "/uxp", maxPayload: 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, "127.0.0.1", () => resolve());
    });
    // The WebSocketServer mirrors the HTTP server's listen errors (e.g.
    // EADDRINUSE). If we do not consume the 'error' event it crashes the whole
    // Node process, taking the CEP daemon down with it. Consume it and allow
    // the caller to observe the failure via the promise rejection instead.
    wss.on("error", () => {});
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("Failed to bind UXP bridge WebSocket server");
    const host = new UxpBridgeHost(http, wss, address.port, options.apiFingerprint, options.authSecret);
    wss.on("connection", (socket) => host.#onConnection(socket));
    return host;
  }

  #onConnection(socket: WebSocket): void {
    socket.on("message", (raw) => this.#onMessage(socket, raw));
    socket.on("close", () => {
      if (this.#socket === socket) {
        this.#socket = null;
        this.#sessionId = null;
        this.#hostVersion = null;
        this.#capabilities.clear();
        for (const [id, pending] of this.#pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error("UXP panel disconnected before completion"));
        }
        this.#pending.clear();
      }
    });
    socket.on("error", () => {});
  }

  #onMessage(socket: WebSocket, raw: Buffer | ArrayBuffer | Buffer[]): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      socket.close(1003, "Invalid JSON");
      return;
    }
    const type = String(msg.type ?? "");

    if (type === "hello") {
      const hello = msg as { authFilePath?: string; clientNonce?: string; apiFingerprint?: string; protocolVersion?: number };
      if (hello.protocolVersion !== 3 || typeof hello.authFilePath !== "string" || typeof hello.clientNonce !== "string" || typeof hello.apiFingerprint !== "string") {
        socket.close(1008, "Unsupported authentication handshake");
        return;
      }
      if (hello.apiFingerprint !== this.#apiFingerprint) {
        socket.close(1008, "Adobe API catalog fingerprint mismatch");
        return;
      }
      const clientNonce = hello.clientNonce;
      const serverNonce = randomBytes(32).toString("hex");
      // Keep the nonces on the socket so the subsequent connect proof can be
      // verified in the next message without persisting any session state.
      (socket as unknown as { __clientNonce?: string; __serverNonce?: string }).__clientNonce = clientNonce;
      (socket as unknown as { __clientNonce?: string; __serverNonce?: string }).__serverNonce = serverNonce;
      socket.send(JSON.stringify({
        type: "challenge",
        protocolVersion: 3,
        serverNonce,
        serverProof: authenticationProof(this.#authSecret, "server", clientNonce, serverNonce, this.#apiFingerprint),
      }));
      return;
    }

    if (type === "connect") {
      const connect = msg as { clientProof?: string; capabilities?: string[]; hostVersion?: string; apiFingerprint?: string; protocolVersion?: number };
      if (connect.protocolVersion !== 3 || typeof connect.clientProof !== "string" || typeof connect.hostVersion !== "string" || typeof connect.apiFingerprint !== "string") {
        socket.close(1008, "Client authentication failed");
        return;
      }
      // We need the client's nonce, which was sent in hello. Since the ws
      // message handler is stateless across hello/connect for a socket, store
      // it on the socket in hello and retrieve here.
      const clientNonce = (socket as unknown as { __clientNonce?: string }).__clientNonce;
      const serverNonce = (socket as unknown as { __serverNonce?: string }).__serverNonce;
      if (!clientNonce || !serverNonce) {
        socket.close(1008, "Client authentication failed");
        return;
      }
      if (connect.apiFingerprint !== this.#apiFingerprint) {
        socket.close(1008, "Adobe API catalog fingerprint mismatch");
        return;
      }
      if (!sameHex(connect.clientProof, authenticationProof(this.#authSecret, "client", clientNonce, serverNonce, this.#apiFingerprint))) {
        socket.close(1008, "Client authentication failed");
        return;
      }
      if (!Array.isArray(connect.capabilities) || connect.capabilities.length > 1024 || !connect.capabilities.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128)) {
        socket.close(1008, "Invalid capability handshake");
        return;
      }
      this.#socket?.close(1012, "Superseded by a new local panel connection");
      this.#socket = socket;
      this.#sessionId = randomUUID();
      this.#hostVersion = connect.hostVersion;
      this.#capabilities = new Set(connect.capabilities);
      socket.send(JSON.stringify({ type: "connected", protocolVersion: 3, sessionId: this.#sessionId }));
      return;
    }

    if (type === "response") {
      const response = msg as { requestId?: string; sessionId?: string; ok?: boolean; result?: unknown; error?: unknown };
      if (typeof response.requestId !== "string" || typeof response.ok !== "boolean") return;
      const pending = this.#pending.get(response.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(response.requestId);
      if (!response.ok) {
        const err = response.error as { message?: string; code?: string } | undefined;
        pending.resolve({ success: false, error: String(err?.message ?? "UXP command failed"), code: String(err?.code ?? "UXP_COMMAND_FAILED") });
      } else {
        pending.resolve({ success: true, data: response.result });
      }
      return;
    }
  }

  get connected(): boolean {
    return this.#socket !== null && this.#socket.readyState === this.#socket.OPEN;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get hostVersion(): string | null {
    return this.#hostVersion;
  }

  get capabilities(): string[] {
    return [...this.#capabilities].sort();
  }

  get port(): number {
    return this.#port;
  }

  get apiFingerprint(): string {
    return this.#apiFingerprint;
  }

  /** Map a session-scoped handle ref to an operation callable via UXP. */
  async dispatch(operation: string, args: Record<string, unknown> = {}, expectedRevision?: string): Promise<unknown> {
    if (!this.connected || !this.#sessionId) {
      return { success: false, error: "Premiere UXP panel is not connected", code: "UXP_UNAVAILABLE" };
    }
    const requestId = randomUUID();
    const request = { type: "command", protocolVersion: 1, requestId, operation, args, expectedRevision, sessionId: this.#sessionId };
    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        resolve({ success: false, error: "Premiere UXP command timed out", code: "UXP_TIMEOUT" });
      }, 30_000);
      this.#pending.set(requestId, { resolve, reject: () => undefined, timer });
      try {
        this.#socket?.send(JSON.stringify(request));
      } catch {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        resolve({ success: false, error: "Premiere UXP panel bridge closed before dispatch", code: "UXP_CLOSED" });
      }
    });
  }

  async close(): Promise<void> {
    for (const entry of this.#pending.values()) clearTimeout(entry.timer);
    this.#pending.clear();
    this.#socket?.close();
    this.#socket = null;
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }
}

export function uxpAuthRootDir(): string {
  return uxpAuthRoot();
}

export function uxpAuthPath(): string {
  return uxpAuthFilePath();
}

export function readUxpAuthSecret(): string {
  const raw = readFileSync(uxpAuthFilePath(), "utf8").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(raw)) throw new Error("UXP authentication data is invalid");
  return raw;
}

/**
 * Return the shared UXP HMAC secret, creating a fresh 256-bit key on first
 * use so the daemon and installer never fail just because the key file does
 * not yet exist. The panel reads the same file during its handshake, so both
 * sides converge on the same secret without any shared external state.
 */
export function ensureUxpAuthSecret(): string {
  const path = uxpAuthFilePath();
  if (existsSync(path)) {
    try { return readUxpAuthSecret(); } catch { /* fall through and regenerate */ }
  }
  const secret = randomBytes(32).toString("hex");
  writeFileSync(path, `${secret}\n`, { mode: 0o600, encoding: "utf8" });
  return secret;
}

export function uxpPluginDataDir(): string {
  return dirname(uxpAuthFilePath());
}
