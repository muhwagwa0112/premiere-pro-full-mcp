import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Backend, BackendAdapter, BackendProbe, BridgeRequest, BridgeResponse, DispatchState, SupportDecision } from "../contracts.js";
import { brokerSign, brokerVerify } from "../security/hmac-broker.js";
import { canonicalJson } from "../security/signed-envelope.js";
import { hasValidEffectiveRequestBinding, routeBindingFromProbe, sameRouteBinding } from "../security/execution-plan.js";

// CEP Chromium timers are heavily throttled while a native approval dialog owns
// the desktop. The heartbeat remains HMAC-authenticated and session-bound, so a
// one-minute freshness window avoids false unavailability without accepting an
// old bridge session indefinitely.
const heartbeatMaxAgeMs = 60_000;

const cepOperations = ["host.inspect", "project.inspect", "sequence.inspect", "project.create", "project.save", "project.checkpoint", "project.open", "media.import", "timeline.sequence.create_from_media", "export.sequence", "workspace.set", "cep.surface.catalog", "cep.read", "cep.edit", "cep.filesystem", "cep.destructive"] as const;
const qeOperations = ["host.inspect", "project.inspect", "sequence.inspect", "qe.catalog", "qe.read", "qe.edit", "qe.destructive"] as const;

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
  readonly #longRunningTimeoutMs: number;
  readonly #authenticate: { sign(value: Record<string, unknown>): Promise<string>; verify(value: Record<string, unknown>, signature: unknown): Promise<boolean> };
  #sessionId: string | null = null;
  #operations = new Set<string>();
  #hostVersion: string | null = null;
  #capabilityFingerprint: string | null = null;

  constructor(backend: "cep" | "qe", directory = process.env.PREMIERE_MCP_CEP_DIR ?? defaultBridgeDirectory(), timeoutMs = 58_000, authenticate = {
    sign: (value: Record<string, unknown>) => brokerSign("cep-hmac", canonicalJson(value)),
    verify: (value: Record<string, unknown>, signature: unknown) => typeof signature === "string" ? brokerVerify("cep-hmac", canonicalJson(value), signature) : Promise.resolve(false),
  }, longRunningTimeoutMs = 5 * 60_000) {
    this.backend = backend;
    this.#directory = directory;
    this.#timeoutMs = timeoutMs;
    this.#longRunningTimeoutMs = Math.max(timeoutMs, longRunningTimeoutMs);
    this.#authenticate = authenticate;
  }

  async probe(): Promise<BackendProbe> {
    try {
      await this.cleanupStaleQueueFiles();
      const heartbeat = JSON.parse(await readFile(join(this.#directory, "heartbeat.json"), "utf8")) as { timestamp?: number; hostVersion?: string; capabilities?: string[]; nonce?: string; sessionId?: string; signature?: string };
      if (!heartbeat.timestamp || Date.now() - heartbeat.timestamp > heartbeatMaxAgeMs) return this.unavailableProbe("CEP heartbeat is stale");
      if (heartbeat.timestamp > Date.now() + 5_000 || typeof heartbeat.nonce !== "string" || typeof heartbeat.sessionId !== "string") return this.unavailableProbe("CEP heartbeat timestamp or session is invalid");
      const { signature, ...unsigned } = heartbeat;
      if (!await this.#authenticate.verify(unsigned, signature)) return this.unavailableProbe("CEP heartbeat signature is invalid");
      if (this.backend === "qe" && !heartbeat.capabilities?.includes("qe")) return this.unavailableProbe("CEP host did not advertise QE capability");
      this.#sessionId = heartbeat.sessionId;
      this.#hostVersion = heartbeat.hostVersion ?? null;
      const operations = this.backend === "qe"
        ? qeOperations
        : heartbeat.capabilities?.includes("typed") ? cepOperations : [];
      this.#operations = new Set(operations);
      this.#capabilityFingerprint = createHash("sha256").update(JSON.stringify({ backend: this.backend, capabilities: [...(heartbeat.capabilities ?? [])].sort(), operations })).digest("hex");
      return {
        backend: this.backend,
        available: true,
        operations,
        hostSessionId: heartbeat.sessionId,
        capabilityFingerprint: this.#capabilityFingerprint,
        ...(heartbeat.hostVersion ? { hostVersion: heartbeat.hostVersion } : {}),
        ...(operations.length === 0 ? { reason: "CEP host did not advertise typed operation support" } : {}),
      };
    } catch {
      return this.unavailableProbe("Typed CEP bridge is not running");
    }
  }

  async supports(operation: string, _context: Record<string, unknown>): Promise<SupportDecision> {
    return this.#operations.has(operation)
      ? { supported: true, state: this.backend === "qe" ? "experimental" : "implemented_unverified", requiredState: [this.backend === "qe" ? "QE enabled" : "typed CEP session"] }
      : { supported: false, state: "unsupported", reason: `${this.backend.toUpperCase()} typed handler does not implement ${operation}` };
  }

  async availability(): Promise<{ available: boolean; reason?: string; hostVersion?: string }> {
    const probe = await this.probe();
    return { available: probe.available, ...(probe.reason ? { reason: probe.reason } : {}), ...(probe.hostVersion ? { hostVersion: probe.hostVersion } : {}) };
  }

  async execute(request: BridgeRequest): Promise<BridgeResponse> {
    if (request.routeBinding || request.planHash || request.effectiveRequestDigest) {
      const currentProbe = await this.probe();
      if (!request.routeBinding || !request.planHash || !hasValidEffectiveRequestBinding(request) || !currentProbe.available || !sameRouteBinding(request.routeBinding, routeBindingFromProbe(currentProbe))) return this.failure(request.requestId, "ROUTE_BINDING_DRIFT", "CEP route, plan, or effective request binding is incomplete or changed before command publication", true, "not_dispatched");
    }
    try {
      await this.cleanupStaleQueueFiles();
    } catch {
      return this.failure(request.requestId, "CEP_QUEUE_UNAVAILABLE", "CEP command queue is unavailable", true, "not_dispatched");
    }
    if (!this.#sessionId) {
      const status = await this.probe();
      if (!status.available || !this.#sessionId) return this.failure(request.requestId, "CEP_SESSION_UNAVAILABLE", status.reason ?? "CEP session is unavailable", true, "not_dispatched");
    }
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
      ...(request.routeBinding ? { routeBinding: request.routeBinding } : {}),
      ...(request.planHash ? { planHash: request.planHash } : {}),
      ...(request.effectiveRequestDigest ? { effectiveRequestDigest: request.effectiveRequestDigest } : {}),
      nonce,
      issuedAt,
      expiresAt: issuedAt + Math.min(this.#timeoutMs, 60_000),
      sessionId: this.#sessionId,
    };
    let body: string;
    try {
      body = JSON.stringify({ ...unsigned, signature: await this.#authenticate.sign(unsigned) });
    } catch {
      return this.failure(request.requestId, "CEP_COMMAND_SIGNING_FAILED", "CEP command could not be authenticated", false, "not_dispatched");
    }
    if (Buffer.byteLength(body, "utf8") > 1024 * 1024) return this.failure(request.requestId, "CEP_MESSAGE_TOO_LARGE", "CEP request exceeds 1 MiB", false, "not_dispatched");
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporaryPath, commandPath);
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      return this.failure(request.requestId, "CEP_COMMAND_PUBLISH_FAILED", "CEP command could not be published", true, "not_dispatched");
    }
    // The signed command must still be accepted within the one-minute
    // freshness window. Once CEP has authenticated and consumed it, a direct
    // sequence render may legitimately need several minutes before its signed
    // response can be produced.
    const responseTimeoutMs = request.operation === "export.sequence" ? this.#longRunningTimeoutMs : this.#timeoutMs;
    const deadline = Date.now() + responseTimeoutMs;
    try {
      while (Date.now() < deadline) {
        try {
          const metadata = await stat(responsePath);
          if (metadata.size > 1024 * 1024) return this.failure(request.requestId, "CEP_RESPONSE_TOO_LARGE", "CEP response exceeds 1 MiB", false, "unknown");
          const response = JSON.parse(await readFile(responsePath, "utf8")) as BridgeResponse & { bridgeNonce?: string; issuedAt?: number; signature?: string };
          if (response.protocolVersion !== 1 || response.requestId !== request.requestId || typeof response.ok !== "boolean") {
            return this.failure(request.requestId, "CEP_PROTOCOL_ERROR", "CEP response failed protocol validation", false, "unknown");
          }
          const { signature, ...responseUnsigned } = response;
          if (response.bridgeNonce !== nonce || typeof response.issuedAt !== "number" || Math.abs(Date.now() - response.issuedAt) > 60_000 || !await this.#authenticate.verify(responseUnsigned, signature)) {
            return this.failure(request.requestId, "CEP_AUTHENTICATION_FAILED", "CEP response signature, nonce, or freshness check failed", false, "unknown");
          }
          const { bridgeNonce: _bridgeNonce, issuedAt: _issuedAt, ...bridgeResponse } = responseUnsigned;
          return { ...(bridgeResponse as unknown as BridgeResponse), dispatchState: "completed" };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return this.failure(request.requestId, "CEP_RESPONSE_ERROR", "CEP response could not be read", false, "unknown");
        }
        await delay(100);
      }
      return this.failure(request.requestId, "CEP_TIMEOUT", "CEP command timed out; it was not retried", false, "unknown");
    } finally {
      await Promise.all([rm(responsePath, { force: true }), rm(commandPath, { force: true }), rm(temporaryPath, { force: true })].map((cleanup) => cleanup.catch(() => undefined)));
    }
  }

  private failure(requestId: string, code: string, message: string, retryable: boolean, dispatchState: DispatchState): BridgeResponse {
    return { protocolVersion: 1, requestId, ok: false, dispatchState, error: { code, message, retryable } };
  }

  private unavailableProbe(reason: string): BackendProbe {
    this.#sessionId = null;
    this.#hostVersion = null;
    this.#capabilityFingerprint = null;
    this.#operations.clear();
    return { backend: this.backend, available: false, operations: [], reason };
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
