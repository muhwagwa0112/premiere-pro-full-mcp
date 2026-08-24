import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { BackendAdapter, BackendProbe, BridgeRequest, BridgeResponse, DispatchState, SupportDecision } from "../contracts.js";

interface UiResponse {
  protocolVersion: 1;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean };
}

export class UiNamedPipeAdapter implements BackendAdapter {
  readonly backend = "ui" as const;
  static readonly operations = ["host.inspect", "ui.catalog", "ui.invoke"] as const;
  readonly #token: string | null;
  readonly #pipePath: string;
  readonly #timeoutMs: number;

  constructor(token = process.env.PREMIERE_MCP_UI_TOKEN ?? null, pipeName = process.env.PREMIERE_MCP_UI_PIPE ?? "PremiereMcpUi", timeoutMs = 5_000) {
    this.#token = token && token.length >= 24 ? token : null;
    this.#pipePath = `\\\\.\\pipe\\${pipeName.replace(/[^A-Za-z0-9_.-]/g, "")}`;
    this.#timeoutMs = Math.max(1, timeoutMs);
  }

  async probe(): Promise<BackendProbe> {
    if (!this.#token) return { backend: this.backend, available: false, operations: [], reason: "PREMIERE_MCP_UI_TOKEN is not configured with at least 24 characters" };
    const response = await this.call("health", {}, this.#timeoutMs);
    return response.ok
      ? { backend: this.backend, available: true, operations: UiNamedPipeAdapter.operations }
      : { backend: this.backend, available: false, operations: [], reason: response.error?.message ?? "UI agent is unavailable" };
  }

  async supports(operation: string, _context: Record<string, unknown>): Promise<SupportDecision> {
    return UiNamedPipeAdapter.operations.includes(operation as (typeof UiNamedPipeAdapter.operations)[number])
      ? { supported: true, state: "contextual", requiredState: ["semantic UI mapping available"] }
      : { supported: false, state: "unsupported", reason: `No versioned semantic UI adapter is registered for ${operation}` };
  }

  async availability(): Promise<{ available: boolean; reason?: string }> {
    const { available, reason } = await this.probe();
    return reason ? { available, reason } : { available };
  }

  async execute(request: BridgeRequest): Promise<BridgeResponse> {
    const operation = request.operation === "host.inspect"
      ? "premiere.window.inspect"
      : request.operation === "ui.catalog"
        ? "premiere.controls.catalog"
        : request.operation === "ui.invoke"
          ? "ui.control.invoke"
          : null;
    if (!operation) {
      return {
        protocolVersion: 1,
        requestId: request.requestId,
        ok: false,
        dispatchState: "not_dispatched",
        error: {
          code: "UI_SEMANTIC_ADAPTER_UNAVAILABLE",
          message: `No versioned semantic UI adapter is registered for ${request.operation}; arbitrary selectors and clicks are disabled`,
          retryable: false,
        },
      };
    }
    const defaultTimeoutMs = operation === "premiere.controls.catalog" ? 50_000 : 5_000;
    const timeoutMs = this.#timeoutMs === 5_000 ? defaultTimeoutMs : operation === "premiere.controls.catalog" ? Math.max(50_000, this.#timeoutMs) : this.#timeoutMs;
    const response = await this.call(operation, request.operation === "host.inspect" ? {} : request.args, timeoutMs);
    if (!response.ok) {
      const dispatchState: DispatchState = response.error?.code === "UI_UNAVAILABLE" || response.error?.code === "UI_TOKEN_MISSING"
        ? "not_dispatched"
        : response.error?.code === "UI_TIMEOUT" || response.error?.code === "UI_DISCONNECTED" || response.error?.code === "UI_PROTOCOL_ERROR" || response.error?.code === "UI_RESPONSE_TOO_LARGE"
          ? "unknown"
          : "completed";
      return { protocolVersion: 1, requestId: request.requestId, ok: false, dispatchState, error: { code: response.error?.code ?? "UI_AGENT_ERROR", message: response.error?.message ?? "UI agent failed", retryable: dispatchState === "unknown" ? false : response.error?.retryable ?? false } };
    }
    return {
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      dispatchState: "completed",
      verification: { outcome: request.operation === "ui.catalog" || request.operation === "host.inspect" ? "verified" : "committed_unverified", method: request.operation === "ui.catalog" ? "bounded semantic UI Automation catalog" : "semantic UI state; host postcondition still required" },
      result: response.result,
    };
  }

  private async call(operation: string, args: Record<string, unknown>, timeoutMs = 5_000): Promise<UiResponse> {
    const requestId = randomUUID();
    if (!this.#token) return { protocolVersion: 1, requestId, ok: false, error: { code: "UI_TOKEN_MISSING", message: "UI token is not configured" } };
    return new Promise<UiResponse>((resolve) => {
      const socket = createConnection(this.#pipePath);
      let buffer = "";
      let connected = false;
      let settled = false;
      const timer = setTimeout(() => {
        socket.destroy();
        done({ protocolVersion: 1, requestId, ok: false, error: { code: connected ? "UI_TIMEOUT" : "UI_UNAVAILABLE", message: connected ? "UI agent timed out after request transmission" : "UI agent connection timed out before request transmission", retryable: !connected } });
      }, timeoutMs);
      const done = (response: UiResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(response);
      };
      socket.once("connect", () => {
        connected = true;
        socket.write(`${JSON.stringify({ protocolVersion: 1, requestId, token: this.#token, operation, args })}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer, "utf8") > 1024 * 1024) return done({ protocolVersion: 1, requestId, ok: false, error: { code: "UI_RESPONSE_TOO_LARGE", message: "UI response exceeds 1 MiB" } });
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          done(JSON.parse(buffer.slice(0, newline)) as UiResponse);
        } catch {
          done({ protocolVersion: 1, requestId, ok: false, error: { code: "UI_PROTOCOL_ERROR", message: "Invalid UI response" } });
        }
      });
      socket.once("error", () => done({ protocolVersion: 1, requestId, ok: false, error: { code: connected ? "UI_DISCONNECTED" : "UI_UNAVAILABLE", message: connected ? "UI agent disconnected after request transmission" : "UI agent named pipe is unavailable", retryable: !connected } }));
      socket.once("close", () => {
        if (!settled) done({ protocolVersion: 1, requestId, ok: false, error: { code: connected ? "UI_DISCONNECTED" : "UI_UNAVAILABLE", message: connected ? "UI agent disconnected after request transmission" : "UI agent named pipe is unavailable", retryable: !connected } });
      });
    });
  }
}
