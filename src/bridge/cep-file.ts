import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Backend, BackendAdapter, BridgeRequest, BridgeResponse } from "../contracts.js";
import { brokerSign, brokerVerify } from "../security/hmac-broker.js";
import { canonicalJson } from "../security/signed-envelope.js";

// CEP Chromium timers are heavily throttled while a native approval dialog owns
// the desktop. The heartbeat remains HMAC-authenticated and session-bound, so a
// one-minute freshness window avoids false unavailability without accepting an
// old bridge session indefinitely.
const heartbeatMaxAgeMs = 60_000;

function defaultBridgeDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  return join(localAppData && localAppData.length > 0 ? localAppData : join(homedir(), "AppData", "Local"), "PremiereMCP", "cep-public-v1");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CepFileAdapter implements BackendAdapter {
  readonly backend: Backend;
  readonly #directory: string;
  readonly #timeoutMs: number;
  readonly #authenticate: { sign(value: Record<string, unknown>): Promise<string>; verify(value: Record<string, unknown>, signature: unknown): Promise<boolean> };
  #sessionId: string | null = null;

  constructor(backend: "cep" | "qe", directory = process.env.PREMIERE_MCP_CEP_DIR ?? defaultBridgeDirectory(), timeoutMs = 45_000, authenticate = {
    sign: (value: Record<string, unknown>) => brokerSign("cep-hmac", canonicalJson(value)),
    verify: (value: Record<string, unknown>, signature: unknown) => typeof signature === "string" ? brokerVerify("cep-hmac", canonicalJson(value), signature) : Promise.resolve(false),
  }) {
    this.backend = backend;
    this.#directory = directory;
    this.#timeoutMs = timeoutMs;
    this.#authenticate = authenticate;
  }

  async availability(): Promise<{ available: boolean; reason?: string; hostVersion?: string }> {
    try {
      await this.cleanupStaleQueueFiles();
      const heartbeat = JSON.parse(await readFile(join(this.#directory, "heartbeat.json"), "utf8")) as { timestamp?: number; hostVersion?: string; capabilities?: string[]; nonce?: string; sessionId?: string; signature?: string };
      if (!heartbeat.timestamp || Date.now() - heartbeat.timestamp > heartbeatMaxAgeMs) return { available: false, reason: "CEP heartbeat is stale" };
      if (heartbeat.timestamp > Date.now() + 5_000 || typeof heartbeat.nonce !== "string" || typeof heartbeat.sessionId !== "string") return { available: false, reason: "CEP heartbeat timestamp or session is invalid" };
      const { signature, ...unsigned } = heartbeat;
      if (!await this.#authenticate.verify(unsigned, signature)) return { available: false, reason: "CEP heartbeat signature is invalid" };
      if (this.backend === "qe" && !heartbeat.capabilities?.includes("qe")) return { available: false, reason: "CEP host did not advertise QE capability" };
      this.#sessionId = heartbeat.sessionId;
      return heartbeat.hostVersion ? { available: true, hostVersion: heartbeat.hostVersion } : { available: true };
    } catch {
      return { available: false, reason: "Typed CEP bridge is not running" };
    }
  }

  async execute(request: BridgeRequest): Promise<BridgeResponse> {
    await this.cleanupStaleQueueFiles();
    if (!this.#sessionId) {
      const status = await this.availability();
      if (!status.available || !this.#sessionId) return this.failure(request.requestId, "CEP_SESSION_UNAVAILABLE", status.reason ?? "CEP session is unavailable", true);
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const nonce = randomUUID();
    const commandPath = join(this.#directory, `command-${nonce}.json`);
    const temporaryPath = `${commandPath}.tmp`;
    const responsePath = join(this.#directory, `response-${nonce}.json`);
    const issuedAt = Date.now();
    const unsigned: Record<string, unknown> = {
      protocolVersion: 1,
      requestId: request.requestId,
      backend: this.backend,
      operation: request.operation,
      args: request.args,
      ...(request.expectedRevision ? { expectedRevision: request.expectedRevision } : {}),
      nonce,
      issuedAt,
      expiresAt: issuedAt + Math.min(this.#timeoutMs, 60_000),
      sessionId: this.#sessionId,
    };
    const body = JSON.stringify({ ...unsigned, signature: await this.#authenticate.sign(unsigned) });
    if (Buffer.byteLength(body, "utf8") > 1024 * 1024) return this.failure(request.requestId, "CEP_MESSAGE_TOO_LARGE", "CEP request exceeds 1 MiB", false);
    await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, commandPath);
    const deadline = Date.now() + this.#timeoutMs;
    try {
      while (Date.now() < deadline) {
        try {
          const metadata = await stat(responsePath);
          if (metadata.size > 1024 * 1024) return this.failure(request.requestId, "CEP_RESPONSE_TOO_LARGE", "CEP response exceeds 1 MiB", false);
          const response = JSON.parse(await readFile(responsePath, "utf8")) as BridgeResponse & { bridgeNonce?: string; issuedAt?: number; signature?: string };
          if (response.protocolVersion !== 1 || response.requestId !== request.requestId || typeof response.ok !== "boolean") {
            return this.failure(request.requestId, "CEP_PROTOCOL_ERROR", "CEP response failed protocol validation", false);
          }
          const { signature, ...responseUnsigned } = response;
          if (response.bridgeNonce !== nonce || typeof response.issuedAt !== "number" || Math.abs(Date.now() - response.issuedAt) > 60_000 || !await this.#authenticate.verify(responseUnsigned, signature)) {
            return this.failure(request.requestId, "CEP_AUTHENTICATION_FAILED", "CEP response signature, nonce, or freshness check failed", false);
          }
          const { bridgeNonce: _bridgeNonce, issuedAt: _issuedAt, ...bridgeResponse } = responseUnsigned;
          return bridgeResponse as unknown as BridgeResponse;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return this.failure(request.requestId, "CEP_RESPONSE_ERROR", "CEP response could not be read", false);
        }
        await delay(100);
      }
      return this.failure(request.requestId, "CEP_TIMEOUT", "CEP command timed out; it was not retried", true);
    } finally {
      await Promise.all([rm(responsePath, { force: true }), rm(commandPath, { force: true }), rm(temporaryPath, { force: true })]);
    }
  }

  private failure(requestId: string, code: string, message: string, retryable: boolean): BridgeResponse {
    return { protocolVersion: 1, requestId, ok: false, error: { code, message, retryable } };
  }

  private async cleanupStaleQueueFiles(maxAgeMs = 2 * 60_000): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of await readdir(this.#directory).catch(() => [] as string[])) {
      if (!/^(command|response)-[0-9a-f-]+\.json(?:\.tmp)?$/i.test(name)) continue;
      const path = join(this.#directory, name);
      const metadata = await stat(path).catch(() => null);
      if (metadata?.isFile() && metadata.mtimeMs < cutoff) await rm(path, { force: true });
    }
  }
}
