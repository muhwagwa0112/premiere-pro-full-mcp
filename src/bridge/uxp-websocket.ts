import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { BackendAdapter, BackendProbe, BridgeRequest, BridgeResponse, DispatchState, SupportDecision } from "../contracts.js";
import { hasValidEffectiveRequestBinding, routeBindingFromProbe, sameRouteBinding } from "../security/execution-plan.js";
import { loadAdobeApiCatalog } from "../adobe-api-catalog.js";
import { brokerProvisionUxpAuthentication, type UxpAuthenticationIdentity } from "../security/hmac-broker.js";
import { runtimeConfig } from "../config.js";

interface HelloMessage {
  type: "hello";
  protocolVersion: 3;
  authFilePath: string;
  clientNonce: string;
  apiFingerprint: string;
  /** "panel" is the default (Premiere panel). "relay" is an MCP follower
   *  instance that shares the leader's panel session. */
  role?: "panel" | "relay";
}

interface ConnectMessage {
  type: "connect";
  protocolVersion: 3;
  clientProof: string;
  hostVersion: string;
  uxpVersion?: string;
  capabilities: string[];
  apiFingerprint: string;
}

interface PeerAcceptedMessage {
  type: "peer-accepted";
  protocolVersion: 3;
  leaderNonce: string;
  hostVersion: string | null;
  hostSessionId: string | null;
  capabilities: string[];
  apiFingerprint: string;
}

interface PeerCommandMessage {
  type: "peer-command";
  protocolVersion: 1;
  peerRequestId: string;
  request: BridgeRequest;
}

interface PeerResponseMessage {
  type: "peer-response";
  protocolVersion: 1;
  peerRequestId: string;
  response: BridgeResponse;
}

interface PeerUpdateMessage {
  type: "peer-update";
  protocolVersion: 3;
  hostVersion: string | null;
  hostSessionId: string | null;
  capabilities: string[];
}

const AUTH_FILE_NAME = "premiere-mcp-bridge-key-v1";
export const BRIDGE_SETTINGS_FILE_NAME = "bridge-settings-v1.json";
const UXP_PLUGIN_ID = "com.codex.premiere-pro-full-mcp";

function authenticationTranscript(role: "client" | "server", clientNonce: string, serverNonce: string, apiFingerprint: string): string {
  return `premiere-mcp-uxp-v3\n${role}\n${clientNonce}\n${serverNonce}\n${apiFingerprint}`;
}

function authenticationProof(secret: string, role: "client" | "server", clientNonce: string, serverNonce: string, apiFingerprint: string): string {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(authenticationTranscript(role, clientNonce, serverNonce, apiFingerprint), "ascii").digest("hex");
}

function sameHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
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
  /** When set, this pending entry was forwarded on behalf of a relay follower
   *  and must be failed when that relay disconnects. */
  relaySocket?: WebSocket;
  /** The relay's opaque request id that must be echoed back with the response. */
  peerRequestId?: string;
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
  readonly #port: number;
  readonly #authRoot: string;
  readonly #provisionAuthentication: () => Promise<UxpAuthenticationIdentity>;
  readonly #pending = new Map<string, PendingRequest>();
  #server: WebSocketServer | null = null;
  #socket: WebSocket | null = null;
  /** Leader mode: relay connections from follower MCP instances that share
   *  this leader's panel session. Follower mode: this adapter's link to the
   *  leader (null when this instance is the leader). */
  readonly #peers = new Set<WebSocket>();
  #leaderLink: WebSocket | null = null;
  #leaderMetadata: { hostVersion: string | null; hostSessionId: string | null; capabilities: string[] } | null = null;
  #hostVersion: string | null = null;
  #hostSessionId: string | null = null;
  #sequenceExportInFlight: string | null = null;
  #capabilities = new Set<string>();
  #apiFingerprint: string | null = null;
  readonly #pendingConnections = new Set<WebSocket>();
  readonly #failedHandshakesByAddress = new Map<string, number[]>();
  #authenticationIdentity: UxpAuthenticationIdentity | null = null;
  #starting = false;
  #closed = false;
  #retryTimer: NodeJS.Timeout | null = null;

  constructor(port = runtimeConfig.uxpPort, authRoot = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Adobe", "UXP", runtimeConfig.uxpPluginsStorage), provisionAuthentication: () => Promise<UxpAuthenticationIdentity> = brokerProvisionUxpAuthentication) {
    this.#port = Number.isInteger(port) && port > 1024 && port < 65536 ? port : runtimeConfig.uxpPort;
    this.#authRoot = resolve(authRoot);
    this.#provisionAuthentication = provisionAuthentication;
  }

  async start(): Promise<void> {
    if (this.#server || this.#starting) return;
    this.#starting = true;
    try {
      const provisionedIdentity = await this.#provisionAuthentication();
      this.#authenticationIdentity = {
        ...provisionedIdentity,
        authFilePath: await realpath(provisionedIdentity.authFilePath),
      };
      // The UXP panel sandbox cannot read process environment variables, so the
      // server publishes the local bridge port into the same plug-in data folder
      // where the panel already reads its authentication key. This removes the
      // hardcoded 17777 from the panel and keeps config as the single source.
      const pluginDataDirectory = dirname(this.#authenticationIdentity.authFilePath);
      await mkdir(pluginDataDirectory, { recursive: true });
      await writeFile(
        join(pluginDataDirectory, BRIDGE_SETTINGS_FILE_NAME),
        `${JSON.stringify({ schemaVersion: 1, port: this.#port })}\n`,
        { encoding: "utf8" },
      );
      this.#apiFingerprint = (await loadAdobeApiCatalog()).fingerprint;
      try {
        await new Promise<void>((resolve, reject) => {
          const server = new WebSocketServer({
            host: "127.0.0.1",
            port: this.#port,
            path: "/uxp",
            maxPayload: 1024 * 1024,
            verifyClient: ({ origin, req }, done) => done(this.isAllowedOrigin(origin) || this.isAllowedRelay(req, origin), 403, "Browser origins are not allowed"),
          });
          this.#server = server;
          server.once("listening", resolve);
          server.once("error", reject);
          server.on("connection", (socket, request) => this.handleConnection(socket, request));
        });
        return;
      } catch {
        if (this.#server) this.#server = null;
        try {
          await this.connectAsFollower();
        } catch {
          // The port is owned but the owner is not yet a compatible relay
          // leader (for example it started before this feature). Keep serving
          // the local adapters and retry ownership shortly so this instance
          // eventually becomes the leader or a working relay.
          if (!this.#closed && !this.#retryTimer) {
            this.#retryTimer = setTimeout(() => {
              this.#retryTimer = null;
              void this.start().catch(() => undefined);
            }, 2_000);
          }
        }
      }
    } finally {
      this.#starting = false;
    }
  }

  private isAllowedRelay(_request: IncomingMessage, origin: string | undefined): boolean {
    // MCP follower instances re-use the same on-disk secret and are allowed to
    // attach as relays when the panel port is already owned by this leader.
    return this.isAllowedOrigin(origin);
  }

  private async connectAsFollower(): Promise<void> {
    const { WebSocket } = await import("ws");
    const secret = this.#authenticationIdentity?.secret;
    if (!secret || !this.#apiFingerprint) throw new Error("UXP follower is unauthenticated");
    const clientNonce = randomBytes(32).toString("hex");
    const socket = new WebSocket(`ws://127.0.0.1:${this.#port}/uxp`, { origin: "file://" });
    this.#leaderLink = socket;
    socket.on("error", () => this.#leaderLink = null);
    socket.on("close", () => {
      if (this.#leaderLink !== socket) return;
      this.#leaderLink = null;
      this.#leaderMetadata = null;
      this.#capabilities.clear();
      for (const [requestId, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.resolve(this.failure(pending.request.requestId, "UXP_LEADER_DISCONNECTED", "Shared UXP leader bridge disconnected before completion", false, "unknown"));
      }
      this.#pending.clear();
      // The leader that owned the panel route is gone. The Post-26.3 UXP panel
      // retries the local port every two seconds, so this instance attempts to
      // bind the port and promote to leader so the panel reconnects instead of
      // leaving every other MCP instance without a shared session.
      if (!this.#closed) void this.start().catch(() => undefined);
    });
    socket.on("message", (data) => this.handleLeaderMessage(socket, data.toString()));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const authFilePath = this.#authenticationIdentity?.authFilePath;
      if (typeof authFilePath !== "string") throw new Error("UXP follower is unauthenticated");
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 3, authFilePath, clientNonce, apiFingerprint: this.#apiFingerprint, role: "relay" } satisfies HelloMessage));
      // Full challenge -> connect relay handshake: prove possession of the same
      // on-disk secret to the leader before we are allowed to share its session.
      const challenge = await this.awaitLeaderMessage(socket, "challenge");
      const serverNonce = String(challenge.serverNonce);
      if (typeof challenge.serverProof !== "string" || !sameHex(challenge.serverProof, authenticationProof(secret, "server", clientNonce, serverNonce, this.#apiFingerprint))) {
        throw new Error("UXP leader relay challenge failed");
      }
      socket.send(JSON.stringify({ type: "connect", protocolVersion: 3, clientProof: authenticationProof(secret, "client", clientNonce, serverNonce, this.#apiFingerprint), hostVersion: "relay", capabilities: [], apiFingerprint: this.#apiFingerprint } satisfies ConnectMessage));
      const accepted = await this.awaitLeaderMessageAny(socket, ["peer-accepted", "connected"]);
      if (accepted.type === "connected") {
        // An older leader does not understand relay roles and accepted us as a
        // fresh panel, which would have superseded the live panel. Release the
        // route immediately so the real panel reconnects instead of stealing it.
        socket.close(1008, "Leader does not support relay sharing");
        throw new Error("UXP leader is not relay-capable; refusing to take over the panel route");
      }
      const peerAccepted = accepted as unknown as PeerAcceptedMessage;
      this.#leaderMetadata = peerAccepted.capabilities ? {
        hostVersion: peerAccepted.hostVersion,
        hostSessionId: peerAccepted.hostSessionId,
        capabilities: [...peerAccepted.capabilities],
      } : null;
      this.#capabilities = new Set(peerAccepted.capabilities ?? []);
    } catch (error) {
      if (this.#leaderLink === socket) this.#leaderLink = null;
      this.#leaderMetadata = null;
      socket.close();
      throw error;
    }
  }

  private awaitLeaderMessage(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
    return this.awaitLeaderMessageAny(socket, [type]);
  }

  private awaitLeaderMessageAny(socket: WebSocket, types: readonly string[]): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("message", onMessage);
        reject(new Error(`UXP leader did not send ${types.join(" or ")}`));
      }, 5_000);
      const onMessage = (data: WebSocket.RawData) => {
        let message: unknown;
        try { message = JSON.parse(data.toString()); } catch { return; }
        if (!message || typeof message !== "object") return;
        if (!types.includes((message as { type?: string }).type ?? "")) return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(message as Record<string, unknown>);
      };
      socket.on("message", onMessage);
    });
  }

  private handleLeaderMessage(socket: WebSocket, rawText: string): void {
    let message: unknown;
    try { message = JSON.parse(rawText); } catch { return; }
    if (!message || typeof message !== "object") return;
    const type = (message as { type?: string }).type;
    if (type === "peer-update") {
      const update = message as PeerUpdateMessage;
      this.#leaderMetadata = { hostVersion: update.hostVersion, hostSessionId: update.hostSessionId, capabilities: [...update.capabilities] };
      this.#capabilities = new Set(update.capabilities);
      return;
    }
    if (type !== "peer-response") return;
    const payload = message as PeerResponseMessage;
    const pending = this.#pending.get(payload.peerRequestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(payload.peerRequestId);
    pending.resolve(payload.response);
  }

  async probe(): Promise<BackendProbe> {
    const base = { backend: this.backend, operations: [...this.#capabilities].sort() } as const;
    if (this.#leaderLink) {
      if (this.#leaderLink.readyState !== this.#leaderLink.OPEN || !this.#leaderMetadata || !this.#leaderMetadata.hostVersion || !this.#leaderMetadata.hostSessionId) {
        return { ...base, available: false, reason: "Premiere UXP panel is not connected to the shared leader bridge" };
      }
      return {
        ...base,
        available: true,
        ...(this.#leaderMetadata.hostVersion ? { hostVersion: this.#leaderMetadata.hostVersion } : {}),
        ...(this.#leaderMetadata.hostSessionId ? { hostSessionId: this.#leaderMetadata.hostSessionId } : {}),
        ...(this.#apiFingerprint ? { capabilityFingerprint: this.#apiFingerprint } : {}),
      };
    }
    if (!this.#server) return { ...base, available: false, reason: "UXP listener is not started" };
    if (!this.#socket || this.#socket.readyState !== this.#socket.OPEN) return { ...base, available: false, reason: "Premiere UXP panel is not connected to the local bridge" };
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
      ? { supported: true, state: "implemented_unverified", requiredState: ["connected local UXP session"] }
      : { supported: false, state: "unsupported", reason: `Connected UXP host did not advertise ${operation}` };
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
    if (!availability.available) return this.failure(request.requestId, "UXP_UNAVAILABLE", availability.reason ?? "UXP unavailable", true, "not_dispatched");
    if (!this.#capabilities.has(request.operation)) return this.failure(request.requestId, "UXP_CAPABILITY_UNAVAILABLE", `Connected host did not advertise ${request.operation}`, false, "not_dispatched");
    if (this.#leaderLink) return this.executeThroughLeader(request);
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
          this.#socket?.send(JSON.stringify({ type: "command", ...request, sessionId: this.#hostSessionId }));
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

  private async executeThroughLeader(request: BridgeRequest): Promise<BridgeResponse> {
    const leader = this.#leaderLink;
    if (!leader || leader.readyState !== leader.OPEN) {
      return this.failure(request.requestId, "UXP_UNAVAILABLE", "UXP leader bridge is not connected", true, "not_dispatched");
    }
    const peerRequestId = randomUUID();
    return await new Promise<BridgeResponse>((resolve) => {
      const payload = { type: "peer-command", protocolVersion: 1, peerRequestId, request } satisfies PeerCommandMessage;
      const timer = setTimeout(() => {
        this.#pending.delete(peerRequestId);
        resolve(this.failure(request.requestId, "UXP_TIMEOUT", "Premiere UXP command timed out via the shared leader bridge; it was not retried", false, "unknown"));
      }, request.operation === "export.sequence" ? 30 * 60_000 : 30_000);
      this.#pending.set(peerRequestId, { resolve, reject: () => undefined, timer, request, outputBaseline: null });
      try {
        leader.send(JSON.stringify(payload));
      } catch {
        clearTimeout(timer);
        this.#pending.delete(peerRequestId);
        resolve(this.failure(request.requestId, "UXP_CLOSED", "UXP leader bridge closed before dispatch", false, "not_dispatched"));
      }
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve(this.failure(requestId, "UXP_CLOSED", "UXP bridge closed before completion", false, "unknown"));
    }
    this.#pending.clear();
    this.#socket?.close();
    this.#socket = null;
    for (const peer of this.#peers) peer.close(1001, "Leader bridge shutting down");
    this.#peers.clear();
    this.#leaderLink?.close();
    this.#leaderLink = null;
    this.#leaderMetadata = null;
    if (this.#server) await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
    this.#server = null;
    this.#pendingConnections.clear();
    this.#failedHandshakesByAddress.clear();
  }

  private broadcastPeerUpdate(): void {
    const update = JSON.stringify({ type: "peer-update", protocolVersion: 3, hostVersion: this.#hostVersion, hostSessionId: this.#hostSessionId, capabilities: [...this.#capabilities] } satisfies PeerUpdateMessage);
    for (const peer of this.#peers) {
      if (peer.readyState === peer.OPEN) peer.send(update);
    }
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const address = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const recentFailures = (this.#failedHandshakesByAddress.get(address) ?? []).filter((timestamp) => now - timestamp < 60_000);
    this.#failedHandshakesByAddress.set(address, recentFailures);
    if (this.#pendingConnections.size >= 4 || recentFailures.length >= 8) {
      socket.close(1013, "Connection handshake rate limit exceeded");
      return;
    }
    this.#pendingConnections.add(socket);
    let connected = false;
    let relayApproved = false;
    let relayRole = false;
    let secret: string | null = null;
    let clientNonce: string | null = null;
    let serverNonce: string | null = null;
    const connectTimer = setTimeout(() => {
      this.#pendingConnections.delete(socket);
      socket.close(1008, "Connection handshake required");
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
      if (!connected) {
        if (!secret) {
          const hello = message as Partial<HelloMessage>;
          if (hello.type !== "hello" || hello.protocolVersion !== 3 || typeof hello.authFilePath !== "string" || typeof hello.clientNonce !== "string" || !/^[a-f0-9]{64}$/.test(hello.clientNonce) || typeof hello.apiFingerprint !== "string") {
            recentFailures.push(Date.now());
            this.#failedHandshakesByAddress.set(address, recentFailures);
            this.#pendingConnections.delete(socket);
            socket.close(1008, "Unsupported authentication handshake");
            return;
          }
          if (!this.#apiFingerprint || hello.apiFingerprint !== this.#apiFingerprint) {
            socket.close(1008, "Adobe API catalog fingerprint mismatch");
            return;
          }
          try { secret = await this.readPanelSecret(hello.authFilePath); }
          catch {
            recentFailures.push(Date.now());
            this.#failedHandshakesByAddress.set(address, recentFailures);
            socket.close(1008, "Automatic local authentication failed");
            return;
          }
          clientNonce = hello.clientNonce;
          serverNonce = randomBytes(32).toString("hex");
          relayRole = hello.role === "relay";
          socket.send(JSON.stringify({ type: "challenge", protocolVersion: 3, serverNonce, serverProof: authenticationProof(secret, "server", clientNonce, serverNonce, this.#apiFingerprint) }));
          return;
        }
        const hello = message as Partial<ConnectMessage>;
        if (hello.type !== "connect" || hello.protocolVersion !== 3 || typeof hello.clientProof !== "string" || !clientNonce || !serverNonce || !this.#apiFingerprint || !sameHex(hello.clientProof, authenticationProof(secret, "client", clientNonce, serverNonce, this.#apiFingerprint))) {
          recentFailures.push(Date.now());
          this.#failedHandshakesByAddress.set(address, recentFailures);
          this.#pendingConnections.delete(socket);
          socket.close(1008, "Client authentication failed");
          return;
        }
        if (relayRole) {
          connected = true;
          relayApproved = true;
          clearTimeout(connectTimer);
          this.#pendingConnections.delete(socket);
          this.#peers.add(socket);
          socket.send(JSON.stringify({ type: "peer-accepted", protocolVersion: 3, leaderNonce: serverNonce, hostVersion: this.#hostVersion, hostSessionId: this.#hostSessionId, capabilities: [...this.#capabilities], apiFingerprint: this.#apiFingerprint } satisfies PeerAcceptedMessage));
          this.broadcastPeerUpdate();
          return;
        }
        if (!Array.isArray(hello.capabilities) || hello.capabilities.length > 1024 || !hello.capabilities.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128) || typeof hello.hostVersion !== "string" || hello.hostVersion.length > 64 || typeof hello.apiFingerprint !== "string") {
          socket.close(1008, "Invalid capability handshake");
          return;
        }
        if (hello.apiFingerprint !== this.#apiFingerprint) {
          socket.close(1008, "Adobe API catalog fingerprint mismatch");
          return;
        }
        connected = true;
        clearTimeout(connectTimer);
        this.#pendingConnections.delete(socket);
        this.#socket?.close(1012, "Superseded by a new local panel connection");
        this.#socket = socket;
        this.#hostVersion = hello.hostVersion;
        this.#capabilities = new Set(hello.capabilities);
        this.#hostSessionId = randomUUID();
        socket.send(JSON.stringify({ type: "connected", protocolVersion: 3, sessionId: this.#hostSessionId }));
        this.broadcastPeerUpdate();
        return;
      }
      if (relayApproved) {
        const peer = message as Partial<PeerCommandMessage>;
        if (peer.type !== "peer-command" || peer.protocolVersion !== 1 || typeof peer.peerRequestId !== "string" || peer.peerRequestId.length > 128) return;
        const peerRequestId = peer.peerRequestId;
        if (!peer.request || typeof peer.request !== "object") {
          socket.send(JSON.stringify({ type: "peer-response", protocolVersion: 1, peerRequestId, response: this.failure("unknown", "UXP_PEER_PROTOCOL", "Shared relay command is missing a request", false, "not_dispatched") } satisfies PeerResponseMessage));
          return;
        }
        const relayed = peer.request as Partial<BridgeRequest>;
        if (!relayed.requestId || !relayed.operation || typeof relayed.args !== "object" || relayed.args === null || Array.isArray(relayed.args)) {
          socket.send(JSON.stringify({ type: "peer-response", protocolVersion: 1, peerRequestId, response: this.failure(String(relayed.requestId ?? "unknown"), "UXP_PEER_PROTOCOL", "Shared relay command is invalid", false, "not_dispatched") } satisfies PeerResponseMessage));
          return;
        }
        const request: BridgeRequest = {
          protocolVersion: 1,
          requestId: relayed.requestId,
          operation: relayed.operation,
          args: relayed.args as Record<string, unknown>,
        };
        if (this.#pending.has(request.requestId) || !this.#socket || this.#socket.readyState !== this.#socket.OPEN) {
          const leaderOpen = Boolean(this.#socket && this.#socket.readyState === this.#socket.OPEN);
          socket.send(JSON.stringify({ type: "peer-response", protocolVersion: 1, peerRequestId, response: this.failure(request.requestId, "UXP_LEADER_BUSY", "UXP leader is not dispatching peer commands right now", !leaderOpen, "not_dispatched") } satisfies PeerResponseMessage));
          return;
        }
        const timer = setTimeout(() => {
          this.#pending.delete(request.requestId);
          socket.send(JSON.stringify({ type: "peer-response", protocolVersion: 1, peerRequestId, response: this.failure(request.requestId, "UXP_TIMEOUT", "Premiere UXP command timed out via the shared relay bridge", false, "unknown") } satisfies PeerResponseMessage));
        }, request.operation === "export.sequence" ? 30 * 60_000 : 30_000);
        this.#pending.set(request.requestId, { resolve: () => undefined, reject: () => undefined, timer, request, outputBaseline: null, relaySocket: socket, peerRequestId });
        try {
          this.#socket.send(JSON.stringify({ type: "command", ...request, sessionId: this.#hostSessionId }));
        } catch {
          clearTimeout(timer);
          this.#pending.delete(request.requestId);
          socket.send(JSON.stringify({ type: "peer-response", protocolVersion: 1, peerRequestId, response: this.failure(request.requestId, "UXP_CLOSED", "UXP panel bridge closed before dispatch", false, "not_dispatched") } satisfies PeerResponseMessage));
        }
        return;
      }
      const response = message as BridgeResponse & { type?: string; sessionId?: string };
      if (response.type !== "response" || response.protocolVersion !== 1 || response.sessionId !== this.#hostSessionId || typeof response.requestId !== "string" || typeof response.ok !== "boolean") return;
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
            : { ...resolved, createdFiles: [{ name: outputPath, verified: true }], verification: { outcome: "verified", method: `Local Premiere UXP dispatch and changed stable file readback (${bytes} bytes)` } };
        }
      }
      if (pending.relaySocket && pending.relaySocket.readyState === pending.relaySocket.OPEN) {
        pending.relaySocket.send(JSON.stringify({ type: "peer-response", protocolVersion: 1, peerRequestId: pending.peerRequestId ?? pending.request.requestId, response: resolved } satisfies PeerResponseMessage));
        return;
      }
      pending.resolve(resolved);
    });
    socket.on("close", () => {
      clearTimeout(connectTimer);
      this.#pendingConnections.delete(socket);
      if (relayApproved) {
        this.#peers.delete(socket);
        this.broadcastPeerUpdate();
        for (const [requestId, pending] of this.#pending) {
          if (pending.relaySocket !== socket) continue;
          clearTimeout(pending.timer);
          this.#pending.delete(requestId);
          pending.resolve(this.failure(requestId, "UXP_RELAY_DISCONNECTED", "Shared UXP relay disconnected before completion; the leader panel state is unchanged", false, "unknown"));
        }
        return;
      }
      if (socket !== this.#socket) return;
      this.#socket = null;
      this.#hostVersion = null;
      this.#hostSessionId = null;
      this.#capabilities.clear();
      this.broadcastPeerUpdate();
      for (const [requestId, pending] of this.#pending) {
        clearTimeout(pending.timer);
        const disconnected = this.failure(requestId, "UXP_DISCONNECTED", "UXP panel disconnected; operation was not replayed", false, "unknown");
        if (pending.relaySocket && pending.relaySocket.readyState === pending.relaySocket.OPEN) {
          pending.relaySocket.send(JSON.stringify({ type: "peer-response", protocolVersion: 1, peerRequestId: pending.peerRequestId ?? requestId, response: disconnected } satisfies PeerResponseMessage));
          continue;
        }
        pending.resolve(disconnected);
      }
      this.#pending.clear();
    });
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    // Premiere Pro 26.3 identifies UXP panel websocket handshakes with the
    // exact file origin below. Missing/opaque/general UXP origins are rejected
    // so browser content and unrelated plug-ins cannot claim the panel route.
    return origin === "file://";
  }

  private async readPanelSecret(authFilePath: string): Promise<string> {
    if (!isAbsolute(authFilePath) || basename(authFilePath) !== AUTH_FILE_NAME || authFilePath.length > 1024) throw new Error("Invalid UXP authentication path");
    const candidate = resolve(authFilePath);
    const relativeCandidate = relative(this.#authRoot, candidate);
    if (!relativeCandidate || relativeCandidate === ".." || relativeCandidate.startsWith(`..${sep}`) || isAbsolute(relativeCandidate)) throw new Error("UXP authentication path escapes the current user profile");
    const parts = relativeCandidate.split(/[\\/]/);
    if (parts.length !== 5 || !/^\d+$/.test(parts[0] ?? "") || parts[1] !== "External" || parts[2] !== UXP_PLUGIN_ID || parts[3] !== "PluginData" || parts[4] !== AUTH_FILE_NAME) throw new Error("UXP authentication path is not scoped to the Premiere Pro Full MCP plug-in");
    const [rootPath, filePath] = await Promise.all([realpath(this.#authRoot), realpath(candidate)]);
    const relativeReal = relative(rootPath, filePath);
    if (!relativeReal || relativeReal === ".." || relativeReal.startsWith(`..${sep}`) || isAbsolute(relativeReal)) throw new Error("UXP authentication file resolves outside the current user profile");
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== 64) throw new Error("UXP authentication file is invalid");
    const identity = this.#authenticationIdentity;
    if (!identity || resolve(identity.authFilePath).toLowerCase() !== resolve(filePath).toLowerCase() || !/^[a-f0-9]{64}$/.test(identity.secret)) throw new Error("UXP authentication identity is not provisioned by the trusted broker");
    return identity.secret;
  }

  private failure(requestId: string, code: string, message: string, retryable: boolean, dispatchState: DispatchState): BridgeResponse {
    return { protocolVersion: 1, requestId, ok: false, dispatchState, error: { code, message, retryable } };
  }
}
