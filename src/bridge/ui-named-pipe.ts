import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { BackendAdapter, BridgeRequest, BridgeResponse } from "../contracts.js";

interface UiResponse {
  protocolVersion: 1;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean };
}

export class UiNamedPipeAdapter implements BackendAdapter {
  readonly backend = "ui" as const;
  readonly #token: string | null;
  readonly #pipePath: string;

  constructor(token = process.env.PREMIERE_MCP_UI_TOKEN ?? null, pipeName = process.env.PREMIERE_MCP_UI_PIPE ?? "PremiereMcpUi") {
    this.#token = token && token.length >= 24 ? token : null;
    this.#pipePath = `\\\\.\\pipe\\${pipeName.replace(/[^A-Za-z0-9_.-]/g, "")}`;
  }

  async availability(): Promise<{ available: boolean; reason?: string }> {
    if (!this.#token) return { available: false, reason: "PREMIERE_MCP_UI_TOKEN is not configured with at least 24 characters" };
    const response = await this.call("health", {});
    return response.ok ? { available: true } : { available: false, reason: response.error?.message ?? "UI agent is unavailable" };
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
        error: {
          code: "UI_SEMANTIC_ADAPTER_UNAVAILABLE",
          message: `No versioned semantic UI adapter is registered for ${request.operation}; arbitrary selectors and clicks are disabled`,
          retryable: false,
        },
      };
    }
    const response = await this.call(operation, request.operation === "host.inspect" ? {} : request.args, operation === "premiere.controls.catalog" ? 50_000 : 5_000);
    if (!response.ok) {
      return { protocolVersion: 1, requestId: request.requestId, ok: false, error: { code: response.error?.code ?? "UI_AGENT_ERROR", message: response.error?.message ?? "UI agent failed", retryable: response.error?.retryable ?? false } };
    }
    return {
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
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
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ protocolVersion: 1, requestId, ok: false, error: { code: "UI_TIMEOUT", message: "UI agent timed out", retryable: true } });
      }, timeoutMs);
      const done = (response: UiResponse) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(response);
      };
      socket.once("connect", () => socket.write(`${JSON.stringify({ protocolVersion: 1, requestId, token: this.#token, operation, args })}\n`));
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
      socket.once("error", () => done({ protocolVersion: 1, requestId, ok: false, error: { code: "UI_UNAVAILABLE", message: "UI agent named pipe is unavailable", retryable: true } }));
    });
  }
}
