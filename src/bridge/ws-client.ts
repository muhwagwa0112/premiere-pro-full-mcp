import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { ExecuteResponse } from "../bridge-types.js";
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
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  #connecting: Promise<void> | null = null;

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
      ws.on("open", () => {
        this.#ws = ws;
        resolve();
      });
      ws.on("error", (error) => reject(error));
      ws.on("message", (raw) => this.#onMessage(raw));
      ws.on("close", () => {
        this.#ws = null;
        this.#connecting = null;
      });
    });
    try {
      await this.#connecting;
    } finally {
      this.#connecting = null;
    }
  }

  #onMessage(raw: WebSocket.RawData): void {
    let msg: ExecuteResponse;
    try {
      msg = JSON.parse(raw.toString()) as ExecuteResponse;
    } catch {
      return;
    }
    if (msg.kind !== "response") return;
    const entry = this.#pending.get(msg.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#pending.delete(msg.requestId);
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(new Error(msg.error?.message ?? "Bridge execution failed"));
  }

  /**
   * Execute a full ExtendScript and return the parsed result.
   * This is the `transport.executeScript` surface upstream handlers expect:
   * they await it and normalize the returned { success, data|error } shape
   * downstream.
   */
  async executeScript(script: string, timeoutMs = 300_000): Promise<unknown> {
    await this.#open();
    const requestId = randomUUID();
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("Bridge connection is not open");
    // Upstream scripts arrive as `return (function(){...})();`. ExtendScript
    // rejects a top-level `return` (ES3 has no module scope), so we wrap the
    // whole payload in an IIFE exactly like the official bridge does. The
    // inner `return` becomes the outer function's return value, which CEP's
    // evalScript callback delivers.
    const wrapped = `(function(){\n${script}\n})();`;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Premiere host execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ kind: "execute", requestId, script: wrapped, timeoutMs }));
    });
  }

  get connected(): boolean {
    return this.#ws !== null && this.#ws.readyState === WebSocket.OPEN;
  }

  get port(): number {
    return this.#port;
  }

  async close(): Promise<void> {
    for (const entry of this.#pending.values()) clearTimeout(entry.timer);
    this.#pending.clear();
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) this.#ws.close();
    this.#ws = null;
  }
}
