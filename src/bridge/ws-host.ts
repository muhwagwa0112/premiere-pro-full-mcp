import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { BridgeEndpoint, ExecuteRequest, ExecuteResponse, ReadyMessage } from "../bridge-types.js";

/**
 * Always-on bridge daemon WebSocket router.
 *
 * Standalone, persistent process installed to auto-start at user logon. It
 * binds a fixed loopback port and stays up whether or not Premiere Pro runs.
 * Two client roles connect to it:
 *
 *   1. The Premiere CEP extension — announces with { kind: "ready" }, receives
 *      { kind: "execute", script }, runs it via evalScript callback, replies
 *      { kind: "response" }.
 *   2. MCP servers — send { kind: "execute" }; the daemon forwards to the CEP
 *      host and relays the response back to the originating MCP client.
 *
 * Endpoint discovery: %LOCALAPPDATA%\PremiereMCP\bridge-endpoint.json
 */

export const DEFAULT_DAEMON_PORT = 48210;

function stateDir(): string {
  const base = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "PremiereMCP")
    : join(tmpdir(), "PremiereMCP");
  mkdirSync(base, { recursive: true });
  return base;
}

function endpointFile(): string {
  return join(stateDir(), "bridge-endpoint.json");
}

function pidFile(): string {
  return join(stateDir(), "bridge-pid.json");
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  source: WebSocket;
}

export class WsHost {
  readonly #http: HttpServer;
  readonly #wss: WebSocketServer;
  readonly #port: number;
  #cepSocket: WebSocket | null = null;
  #pending = new Map<string, PendingEntry>();

  private constructor(http: HttpServer, wss: WebSocketServer, port: number) {
    this.#http = http;
    this.#wss = wss;
    this.#port = port;
  }

  static async start(port = DEFAULT_DAEMON_PORT): Promise<WsHost> {
    const http = createHttpServer();
    const wss = new WebSocketServer({ server: http, path: "/bridge" });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, "127.0.0.1", () => resolve());
    });
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("Failed to bind loopback WebSocket server");
    const actualPort = address.port;

    // Only the daemon (fixed port) is allowed to publish the endpoint. Tests
    // start on port 0 for isolation and must not clobber the live daemon's
    // endpoint/pid files.
    if (port !== 0) {
      const endpoint: BridgeEndpoint = { port: actualPort, host: "127.0.0.1", protocol: "ws" };
      writeFileSync(endpointFile(), JSON.stringify(endpoint, null, 2), "utf8");
      writeFileSync(pidFile(), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8");
    }

    const host = new WsHost(http, wss, actualPort);
    wss.on("connection", (socket) => host.#onConnection(socket));
    return host;
  }

  #onConnection(socket: WebSocket): void {
    socket.on("message", (raw) => this.#onMessage(socket, raw));
    socket.on("close", () => {
      if (this.#cepSocket === socket) this.#cepSocket = null;
    });
    socket.on("error", () => {});
  }

  #onMessage(socket: WebSocket, raw: Buffer | ArrayBuffer | Buffer[]): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    const kind = String(msg.kind ?? "");
    if (kind === "ready") {
      this.#cepSocket = socket;
      socket.send(JSON.stringify({ kind: "hello", ok: true, port: this.#port }));
      return;
    }
    if (kind === "execute") {
      this.#dispatchExecute(socket, msg as unknown as ExecuteRequest);
      return;
    }
    if (kind === "response") {
      this.#relayResponse(socket, msg);
      return;
    }
  }

  #dispatchExecute(source: WebSocket, req: ExecuteRequest): void {
    const requestId = String(req.requestId ?? randomUUID());
    if (!this.#cepSocket) {
      source.send(
        JSON.stringify({
          kind: "response",
          requestId,
          ok: false,
          error: { code: "HOST_NOT_CONNECTED", message: "Premiere Pro host is not connected to the bridge" },
        } satisfies ExecuteResponse),
      );
      return;
    }
    this.#reservePending(requestId, source);
    this.#cepSocket.send(JSON.stringify({ kind: "execute", requestId, script: req.script, timeoutMs: req.timeoutMs }));
  }

  #reservePending(requestId: string, source: WebSocket): void {
    if (this.#pending.has(requestId)) return;
    const timer = setTimeout(() => {
      this.#pending.delete(requestId);
      if (source.readyState === source.OPEN) {
        source.send(
          JSON.stringify({
            kind: "response",
            requestId,
            ok: false,
            error: { code: "EXECUTION_TIMEOUT", message: "Premiere Pro did not respond in time" },
          } satisfies ExecuteResponse),
        );
      }
    }, 300_000);
    this.#pending.set(requestId, {
      resolve: () => {},
      reject: () => {},
      timer,
      source,
    });
  }

  #relayResponse(_cepSocket: WebSocket, msg: Record<string, unknown>): void {
    const requestId = String(msg.requestId ?? "");
    const entry = this.#pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#pending.delete(requestId);
    if (entry.source.readyState === entry.source.OPEN) {
      entry.source.send(JSON.stringify({ ...msg, requestId, kind: "response" }));
    }
  }

  /**
   * In-process request path used by tests and a stdio server that embeds the
   * daemon directly. Real MCP servers connect over the loopback WS instead.
   */
  async request(script: string, args: Record<string, unknown> = {}, tool = "call"): Promise<unknown> {
    void args;
    const requestId = randomUUID();
    if (!this.#cepSocket) throw new Error("Premiere CEP host is not connected");
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Bridge request ${tool} timed out`)), 300_000);
      this.#pending.set(requestId, { resolve, reject, timer, source: this.#outboxSocket() });
    });
    this.#cepSocket.send(JSON.stringify({ kind: "execute", requestId, script, tool }));
    return await promise;
  }

  #outboxSocket(): WebSocket {
    for (const client of this.#wss.clients) {
      if (client.readyState === client.OPEN) return client;
    }
    return { readyState: -1, send: () => {} } as unknown as WebSocket;
  }

  get connected(): boolean {
    return this.#cepSocket !== null;
  }

  get premiereConnected(): boolean {
    return this.#cepSocket !== null;
  }

  get port(): number {
    return this.#port;
  }

  async close(): Promise<void> {
    for (const entry of this.#pending.values()) clearTimeout(entry.timer);
    this.#pending.clear();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }
}

export function bridgeEndpointPath(): string {
  return endpointFile();
}

export function readBridgeEndpoint(): BridgeEndpoint | null {
  try {
    const raw = readFileSync(endpointFile(), "utf8");
    const parsed = JSON.parse(raw) as BridgeEndpoint;
    if (parsed && typeof parsed.port === "number" && parsed.host === "127.0.0.1" && parsed.protocol === "ws") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function daemonStateDir(): string {
  return stateDir();
}

export const daemonEndpointPath = endpointFile;
export const daemonPidFile = pidFile;
