import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  APPROVED_CEP_EXTENSION_ID,
  CEP_BRIDGE_PROTOCOL_VERSION,
  normalizeExecutionTimeout,
  type AcknowledgeRecoveryWireRequest,
  type BeginOperationWireRequest,
  type BridgeEndpoint,
  type EndOperationWireRequest,
  type ExecuteRequest,
  type ExecuteResponse,
  type DomReadinessProbeResult,
  type DomReadinessStatus,
  type HostSession,
  type OperationWireMetadata,
  type ReadyMessage,
} from "../bridge-types.js";
import { OperationCoordinator } from "../operations/coordinator.js";
import { payloadMetadata } from "../operations/ledger.js";
import { OperationExecutionUnknownError, type OperationSnapshot } from "../operations/types.js";
import { UxpBridgeHost } from "./uxp-host.js";

export const DEFAULT_DAEMON_PORT = 48210;

function stateDir(): string {
  const base = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "PremiereMCP") : join(tmpdir(), "PremiereMCP");
  mkdirSync(base, { recursive: true });
  return base;
}
function endpointFile(): string { return join(stateDir(), "bridge-endpoint.json"); }
function pidFile(): string { return join(stateDir(), "bridge-pid.json"); }
function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
function errorCode(error: unknown): string {
  return String((error as { code?: unknown } | null)?.code ?? (error as { name?: unknown } | null)?.name ?? "BRIDGE_OPERATION_FAILED");
}

interface PendingEntry {
  timer: ReturnType<typeof setTimeout>;
  source: WebSocket | null;
  cepSocket: WebSocket;
  operation: "execute" | "host_probe" | "dom_readiness_probe";
  metadata?: OperationWireMetadata;
  lateSource?: WebSocket;
  resolve?: (value: unknown) => void;
  reject?: (error: Error) => void;
}
interface LateEntry {
  source: WebSocket;
  cepSocket: WebSocket;
  operation?: OperationWireMetadata;
  timer: ReturnType<typeof setTimeout>;
}
interface ReconciliationState {
  operationId: string;
  state: "PENDING" | "BOUNDED_MATCH" | "CHANGED_FROM_PRE" | "INCOMPARABLE_PROJECTION" | "NO_PRE_SNAPSHOT" | "FAILED";
  observedFingerprint?: string;
  checkedAt?: string;
  errorCode?: string;
}
interface ActiveWireOperation {
  source: WebSocket;
  mode: "read" | "mutate";
}

export interface WsHostOptions {
  heartbeatMs?: number;
  coordinator?: OperationCoordinator;
  /** Total queue-wait plus evalScript allowance for mutation snapshots. */
  snapshotBudgetMs?: number;
}

const SNAPSHOT_JSON_HELPERS = String.raw`
      function __jsonQuote(value) {
        return '"' + String(value).replace(/[\\"\x00-\x1f]/g, function(ch) {
          if (ch === '"') return '\\"';
          if (ch === '\\') return '\\\\';
          if (ch === '\b') return '\\b';
          if (ch === '\f') return '\\f';
          if (ch === '\n') return '\\n';
          if (ch === '\r') return '\\r';
          if (ch === '\t') return '\\t';
          var hex = ch.charCodeAt(0).toString(16);
          return '\\u' + ('0000' + hex).substring(hex.length);
        }) + '"';
      }
      function __jsonStringify(value) {
        if (value === null) return 'null';
        var kind = typeof value;
        if (kind === 'string') return __jsonQuote(value);
        if (kind === 'boolean') return value ? 'true' : 'false';
        if (kind === 'number') return isFinite(value) ? String(value) : 'null';
        if (kind === 'undefined' || kind === 'function') return undefined;
        if (value instanceof Array) {
          var items = [];
          for (var i = 0; i < value.length; i++) {
            var item = __jsonStringify(value[i]);
            items.push(item === undefined ? 'null' : item);
          }
          return '[' + items.join(',') + ']';
        }
        var parts = [];
        for (var key in value) {
          if (value.hasOwnProperty && !value.hasOwnProperty(key)) continue;
          var encoded = __jsonStringify(value[key]);
          if (encoded !== undefined) parts.push(__jsonQuote(key) + ':' + encoded);
        }
        return '{' + parts.join(',') + '}';
      }`;

function buildSnapshotScript(targetHint?: string, targetKind?: string, toolName?: string): string {
  if (toolName === "execute_extendscript") {
    return `(function(){
      ${SNAPSHOT_JSON_HELPERS}
      try {
        var p = app.project;
        var active = p ? p.activeSequence : null;
        var projectState = p ? {
          name: String(p.name || ""),
          path: String(p.path || "")
        } : null;
        var endSeconds = null;
        if (active && active.end) endSeconds = Number(active.end.seconds);
        var sequenceState = active ? {
          name: String(active.name || ""),
          sequenceID: String(active.sequenceID || ""),
          endSeconds: endSeconds
        } : null;
        return __jsonStringify({
          project: projectState,
          projectState: projectState,
          activeSequence: sequenceState,
          targetSequence: sequenceState,
          targetState: sequenceState,
          coverage: "project"
        });
      } catch (e) { return __jsonStringify({ snapshotError: String(e) }); }
    })();`;
  }
  const includeComponents = /effect|keyframe|opacity|position|scale|rotation|motion|execute_extendscript|set_clip_/i.test(toolName ?? "");
  return `(function(){
    ${SNAPSHOT_JSON_HELPERS}
    try {
      var p = app.project;
      var active = p ? p.activeSequence : null;
      var targetHint = ${JSON.stringify(targetHint ?? "")};
      var targetKind = ${JSON.stringify(targetKind ?? "")};
      var includeComponents = ${includeComponents ? "true" : "false"};
      var MAX_TRACKS = 32, MAX_CLIPS = 256, MAX_COMPONENT_CLIPS = 16;
      var MAX_PROJECT_ITEMS = 512, MAX_PROJECT_SEQUENCES = 128;
      var MAX_COMPONENTS = 12, MAX_PROPERTIES = 32, MAX_PROPERTIES_TOTAL = 256;
      var propertiesCaptured = 0;
      function safe(fn, fallback) { try { var value = fn(); return value === undefined ? fallback : value; } catch (_) { return fallback; } }
      function scalar(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
        if (value.ticks !== undefined || value.seconds !== undefined) return { ticks: safe(function(){ return String(value.ticks); }, null), seconds: safe(function(){ return Number(value.seconds); }, null) };
        if (value.length !== undefined && typeof value !== "string") {
          var list = [], limit = Math.min(Number(value.length) || 0, 8);
          for (var a = 0; a < limit; a++) list.push(scalar(value[a]));
          return list;
        }
        return safe(function(){ return String(value); }, null);
      }
      function timeValue(owner, key) { return scalar(safe(function(){ return owner[key]; }, null)); }
      function captureProperty(prop, propertyIndex, sampleSeconds) {
        var timeVarying = safe(function(){ return Boolean(prop.isTimeVarying()); }, null), samples = [];
        if (timeVarying === true) {
          for (var sampleIndex = 0; sampleIndex < sampleSeconds.length; sampleIndex++) {
            var seconds = sampleSeconds[sampleIndex];
            samples.push({ seconds: seconds, value: scalar(safe(function(){ var time = new Time(); time.seconds = seconds; return prop.getValueAtTime(time); }, null)) });
          }
        }
        return {
          index: propertyIndex,
          displayName: safe(function(){ return prop.displayName; }, null),
          matchName: safe(function(){ return prop.matchName; }, null),
          timeVarying: timeVarying,
          value: scalar(safe(function(){ return prop.getValue(); }, null)),
          samples: samples,
          keyCoverage: timeVarying === true ? "sampled-values-no-key-enumeration" : "not-time-varying"
        };
      }
      function captureComponents(clip, sampleSeconds) {
        var collection = safe(function(){ return clip.components; }, null);
        var count = collection ? Number(collection.numItems) || 0 : 0;
        var result = [], limit = Math.min(count, MAX_COMPONENTS);
        for (var c = 0; c < limit; c++) {
          var component = collection[c], properties = safe(function(){ return component.properties; }, null);
          var propertyCount = properties ? Number(properties.numItems) || 0 : 0;
          var propertyStates = [], propertyLimit = Math.min(propertyCount, MAX_PROPERTIES, MAX_PROPERTIES_TOTAL - propertiesCaptured);
          for (var q = 0; q < propertyLimit; q++) { propertyStates.push(captureProperty(properties[q], q, sampleSeconds)); propertiesCaptured++; }
          result.push({
            index: c,
            displayName: safe(function(){ return component.displayName; }, null),
            matchName: safe(function(){ return component.matchName; }, null),
            properties: propertyStates,
            propertyCount: propertyCount,
            propertiesTruncated: propertyCount > propertyLimit || propertiesCaptured >= MAX_PROPERTIES_TOTAL
          });
        }
        return { items: result, count: count, truncated: count > limit };
      }
      function captureClip(clip, mediaType, trackIndex, clipIndex, componentSlot) {
        var item = safe(function(){ return clip.projectItem; }, null);
        var state = {
          mediaType: mediaType, trackIndex: trackIndex, clipIndex: clipIndex,
          nodeId: safe(function(){ return String(clip.nodeId); }, null),
          name: safe(function(){ return clip.name; }, null),
          projectItem: item ? { nodeId: safe(function(){ return String(item.nodeId); }, null), name: safe(function(){ return item.name; }, null), type: safe(function(){ return String(item.type); }, null) } : null,
          start: timeValue(clip, "start"), end: timeValue(clip, "end"),
          inPoint: timeValue(clip, "inPoint"), outPoint: timeValue(clip, "outPoint"), duration: timeValue(clip, "duration"),
          speed: safe(function(){ return Number(clip.getSpeed()); }, null), reversed: safe(function(){ return Boolean(clip.isSpeedReversed()); }, null)
        };
        var startSeconds = safe(function(){ return Number(clip.start.seconds); }, null), endSeconds = safe(function(){ return Number(clip.end.seconds); }, null), sampleSeconds = [];
        if (startSeconds !== null && endSeconds !== null) sampleSeconds = [startSeconds, startSeconds + ((endSeconds - startSeconds) / 2), endSeconds];
        if (includeComponents && componentSlot < MAX_COMPONENT_CLIPS && propertiesCaptured < MAX_PROPERTIES_TOTAL) state.components = captureComponents(clip, sampleSeconds);
        return state;
      }
      function captureSequence(sequence) {
        if (!sequence) return null;
        var settings = safe(function(){ return sequence.getSettings(); }, null);
        var settingNames = ["editingMode", "videoFrameWidth", "videoFrameHeight", "videoPixelAspectRatio", "videoFieldType", "videoDisplayFormat", "videoFrameRate", "audioChannelType", "audioChannelCount", "audioSampleRate", "audioDisplayFormat", "previewFileFormat", "previewCodec", "maximumBitDepth", "maximumRenderQuality", "compositeLinearColor", "workingColorSpace", "autoToneMapEnabled", "vrProjection", "vrLayout"];
        var settingState = {};
        for (var settingIndex = 0; settings && settingIndex < settingNames.length; settingIndex++) {
          var settingName = settingNames[settingIndex];
          settingState[settingName] = scalar(safe(function(){ return settings[settingName]; }, null));
        }
        var clips = [], totalClips = 0, componentSlots = 0;
        var videoTracks = safe(function(){ return sequence.videoTracks; }, null);
        var audioTracks = safe(function(){ return sequence.audioTracks; }, null);
        function captureTracks(tracks, mediaType) {
          var trackCount = tracks ? Number(tracks.numTracks) || 0 : 0;
          var trackLimit = Math.min(trackCount, MAX_TRACKS);
          for (var t = 0; t < trackLimit; t++) {
            var track = tracks[t], trackClips = safe(function(){ return track.clips; }, null);
            var clipCount = trackClips ? Number(trackClips.numItems) || 0 : 0;
            totalClips += clipCount;
            for (var i = 0; i < clipCount && clips.length < MAX_CLIPS; i++) {
              clips.push(captureClip(trackClips[i], mediaType, t, i, componentSlots));
              componentSlots++;
            }
          }
          return { count: trackCount, truncated: trackCount > trackLimit };
        }
        var video = captureTracks(videoTracks, "video"), audio = captureTracks(audioTracks, "audio");
        return {
          name: safe(function(){ return sequence.name; }, null), sequenceID: safe(function(){ return String(sequence.sequenceID); }, null),
          end: timeValue(sequence, "end"), zeroPoint: safe(function(){ return String(sequence.zeroPoint); }, null),
          settings: settingState,
          videoTracks: video, audioTracks: audio, clips: clips, totalClips: totalClips,
          clipsTruncated: totalClips > clips.length,
          componentCoverage: includeComponents ? { capturedClipCount: Math.min(componentSlots, MAX_COMPONENT_CLIPS), maxClipCount: MAX_COMPONENT_CLIPS, capturedPropertyCount: propertiesCaptured, maxPropertyCount: MAX_PROPERTIES_TOTAL, keyValues: "three-point-sampling-without-key-enumeration" } : null
        };
      }
      function captureProject(project) {
        if (!project) return null;
        var sequences = [], sequenceCount = safe(function(){ return Number(project.sequences.numSequences) || 0; }, 0);
        var sequenceLimit = Math.min(sequenceCount, MAX_PROJECT_SEQUENCES);
        for (var s = 0; s < sequenceLimit; s++) {
          var seq = project.sequences[s];
          sequences.push({ name: safe(function(){ return seq.name; }, null), sequenceID: safe(function(){ return String(seq.sequenceID); }, null), end: timeValue(seq, "end") });
        }
        var items = [], stack = [], root = safe(function(){ return project.rootItem; }, null), visited = 0, skippedChildren = 0;
        if (root) stack.push({ item: root, parent: null, depth: 0 });
        while (stack.length && items.length < MAX_PROJECT_ITEMS) {
          var entry = stack.pop(), projectItem = entry.item;
          var children = safe(function(){ return projectItem.children; }, null);
          var childCount = children ? Number(children.numItems) || 0 : 0;
          var nodeId = safe(function(){ return String(projectItem.nodeId); }, null);
          items.push({ nodeId: nodeId, parent: entry.parent, depth: entry.depth, name: safe(function(){ return projectItem.name; }, null), type: safe(function(){ return String(projectItem.type); }, null), childCount: childCount });
          visited++;
          var remaining = Math.max(0, MAX_PROJECT_ITEMS - items.length - stack.length);
          var pushCount = Math.min(childCount, remaining);
          skippedChildren += childCount - pushCount;
          for (var childIndex = pushCount - 1; childIndex >= 0; childIndex--) stack.push({ item: children[childIndex], parent: nodeId, depth: entry.depth + 1 });
        }
        return {
          identity: { name: safe(function(){ return project.name; }, null), path: safe(function(){ return project.path; }, null), documentID: safe(function(){ return project.documentID; }, null) },
          sequences: sequences, sequenceCount: sequenceCount, sequencesTruncated: sequenceCount > sequenceLimit,
          items: items, itemsTruncated: stack.length > 0 || skippedChildren > 0, capturedItemCount: visited, skippedChildCount: skippedChildren
        };
      }
      var target = (targetKind === "sequence" || targetKind === "clip") ? active : null;
      if (p && targetKind === "sequence" && targetHint && targetHint !== "active-sequence") {
        target = null;
        for (var i = 0; i < p.sequences.numSequences; i++) {
          var candidate = p.sequences[i];
          if (String(candidate.sequenceID) === targetHint || String(candidate.name) === targetHint) { target = candidate; break; }
        }
        if (!target) return __jsonStringify({ snapshotError: "Target sequence not found" });
      }
      return __jsonStringify({
        project: p ? { name: p.name || null, path: p.path || null, documentID: p.documentID || null } : null,
        projectState: captureProject(p),
        activeSequence: active ? { name: active.name || null, sequenceID: active.sequenceID || null } : null,
        targetSequence: target ? { name: target.name || null, sequenceID: target.sequenceID || null, end: timeValue(target, "end") } : null,
        targetState: captureSequence(target),
        coverage: includeComponents ? "clip-components" : (target ? "timeline" : "project")
      });
    } catch (e) { return __jsonStringify({ snapshotError: String(e) }); }
  })();`;
}

function guardActiveSequenceScript(script: string, expectedSequenceId: string): string {
  return `(function(){
    var __active = app.project ? app.project.activeSequence : null;
    if (!__active || String(__active.sequenceID) !== ${JSON.stringify(expectedSequenceId)}) {
      return JSON.stringify({ success: false, error: "Active sequence changed after operation preflight", code: "ACTIVE_SEQUENCE_CHANGED" });
    }
    return ${script};
  })();`;
}

export class WsHost {
  readonly #http: HttpServer;
  readonly #wss: WebSocketServer;
  readonly #port: number;
  readonly #coordinator: OperationCoordinator | null;
  readonly #snapshotBudgetMs: number;
  #cepSocket: WebSocket | null = null;
  #uxpBridge: UxpBridgeHost | null = null;
  #pending = new Map<string, PendingEntry>();
  #late = new Map<string, LateEntry>();
  #hostSession: HostSession | null = null;
  #generation = 0;
  #alive = new WeakMap<WebSocket, boolean>();
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #cepTail: Promise<void> = Promise.resolve();
  #cepQueueDepth = 0;
  #reconciliation = new Map<string, ReconciliationState>();
  #lastMutationPreflightAt: string | null = null;
  #lastMutationPreflightResponsive: boolean | null = null;
  #lastMutationPreflightError: string | null = null;
  #activeWireOperations = new Map<string, ActiveWireOperation>();
  #domReadiness: DomReadinessStatus = {
    lastCheckedAt: null, lastSuccessfulAt: null, domReady: null, errorCode: null,
    consecutiveSuccesses: 0, sessionId: null, generation: null,
  };

  private constructor(http: HttpServer, wss: WebSocketServer, port: number, options: WsHostOptions) {
    this.#http = http;
    this.#wss = wss;
    this.#port = port;
    this.#coordinator = options.coordinator ?? null;
    this.#snapshotBudgetMs = typeof options.snapshotBudgetMs === "number" && Number.isFinite(options.snapshotBudgetMs)
      ? Math.max(10, Math.trunc(options.snapshotBudgetMs))
      : 5_000;
    const heartbeatMs = options.heartbeatMs ?? 15_000;
    if (heartbeatMs > 0) {
      this.#heartbeat = setInterval(() => this.#checkTransportLiveness(), heartbeatMs);
      this.#heartbeat.unref();
    }
  }

  setUxpBridge(bridge: UxpBridgeHost | null): void { this.#uxpBridge = bridge; }

  static async start(port = DEFAULT_DAEMON_PORT, options: WsHostOptions = {}): Promise<WsHost> {
    const http = createHttpServer();
    const wss = new WebSocketServer({ server: http, path: "/bridge" });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, "127.0.0.1", resolve);
    });
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("Failed to bind loopback WebSocket server");
    if (port !== 0) {
      const endpoint: BridgeEndpoint = { port: address.port, host: "127.0.0.1", protocol: "ws" };
      writeFileSync(endpointFile(), JSON.stringify(endpoint, null, 2), "utf8");
      writeFileSync(pidFile(), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8");
    }
    const host = new WsHost(http, wss, address.port, options);
    wss.on("connection", (socket) => host.#onConnection(socket));
    return host;
  }

  #onConnection(socket: WebSocket): void {
    this.#alive.set(socket, true);
    socket.on("message", (raw) => this.#onMessage(socket, raw));
    socket.on("pong", () => this.#alive.set(socket, true));
    socket.on("close", () => this.#handleSocketClose(socket));
    socket.on("error", () => {});
  }
  #checkTransportLiveness(): void {
    for (const socket of this.#wss.clients) {
      if (this.#alive.get(socket) === false) { socket.terminate(); continue; }
      this.#alive.set(socket, false);
      try { socket.ping(); } catch { socket.terminate(); }
    }
  }
  #handleSocketClose(socket: WebSocket): void {
    if (this.#cepSocket === socket) {
      this.#cepSocket = null;
      this.#hostSession = null;
      this.#domReadiness = {
        ...this.#domReadiness,
        domReady: false,
        errorCode: "HOST_DISCONNECTED",
        consecutiveSuccesses: 0,
        sessionId: null,
        generation: null,
      };
      this.#failPendingForCep(socket, "HOST_DISCONNECTED", "Premiere Pro host disconnected during execution");
    }
    for (const [operationId, active] of this.#activeWireOperations) {
      if (active.source === socket) void this.#finalizeOrphanOperation(operationId, active);
    }
    for (const [requestId, entry] of this.#pending) {
      if (entry.source !== socket) continue;
      clearTimeout(entry.timer);
      this.#pending.delete(requestId);
      entry.reject?.(codedError("SOURCE_DISCONNECTED", "Bridge request source disconnected"));
    }
    for (const [requestId, entry] of this.#late) {
      if (entry.source !== socket && entry.cepSocket !== socket) continue;
      clearTimeout(entry.timer);
      this.#late.delete(requestId);
    }
  }

  #onMessage(socket: WebSocket, raw: Buffer | ArrayBuffer | Buffer[]): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
    const kind = String(msg.kind ?? "");
    if (kind === "ready") { this.#adoptCep(socket, msg as unknown as ReadyMessage); return; }
    if (kind === "execute") { void this.#dispatchExecute(socket, msg as unknown as ExecuteRequest); return; }
    if (kind === "host_probe") { void this.#dispatchHostProbe(socket, msg); return; }
    if (kind === "dom_readiness_probe") { void this.#dispatchDomReadinessProbe(socket, msg); return; }
    if (kind === "uxp") { void this.#dispatchUxp(socket, msg); return; }
    if (kind === "begin_operation") { void this.#beginOperation(socket, msg as unknown as BeginOperationWireRequest); return; }
    if (kind === "end_operation") { void this.#endOperation(socket, msg as unknown as EndOperationWireRequest); return; }
    if (kind === "operation_status") { void this.#operationStatus(socket, String(msg.requestId ?? randomUUID())); return; }
    if (kind === "recovery_snapshot") { void this.#recoverySnapshot(socket, String(msg.requestId ?? randomUUID()), String(msg.operationId ?? "")); return; }
    if (kind === "acknowledge_recovery") { void this.#acknowledgeRecovery(socket, msg as unknown as AcknowledgeRecoveryWireRequest); return; }
    if (kind === "response") { this.#relayResponse(socket, msg); return; }
    if (kind === "late_completion") this.#relayLateCompletion(socket, msg);
  }

  #adoptCep(socket: WebSocket, ready: ReadyMessage): void {
    const identity = ready?.identity;
    const validIdentity = Boolean(
      identity
      && identity.extensionId === APPROVED_CEP_EXTENSION_ID
      && identity.protocolVersion === CEP_BRIDGE_PROTOCOL_VERSION
      && typeof identity.instanceId === "string"
      && identity.instanceId.trim().length > 0,
    );
    if (!validIdentity) {
      const receivedExtensionId = typeof identity?.extensionId === "string" ? identity.extensionId : "missing";
      const receivedProtocolVersion = typeof identity?.protocolVersion === "number" ? String(identity.protocolVersion) : "missing";
      socket.send(JSON.stringify({
        kind: "hello",
        ok: false,
        error: {
          code: "CEP_HOST_REJECTED",
          message: `CEP ready identity rejected (extensionId=${receivedExtensionId}, protocolVersion=${receivedProtocolVersion})`,
          expectedExtensionId: APPROVED_CEP_EXTENSION_ID,
          expectedProtocolVersion: CEP_BRIDGE_PROTOCOL_VERSION,
        },
      }));
      return;
    }
    if (this.#cepSocket && this.#cepSocket !== socket) {
      this.#failPendingForCep(this.#cepSocket, "HOST_REPLACED", "Premiere Pro host reconnected during execution");
    }
    this.#cepSocket = socket;
    const premiereVersion = typeof ready.premiereVersion === "string" ? ready.premiereVersion : undefined;
    const session: HostSession = {
      sessionId: randomUUID(), generation: ++this.#generation,
      identity: { ...identity },
      ...(premiereVersion ? { premiereVersion, version: premiereVersion } : {}),
    };
    this.#hostSession = session;
    this.#domReadiness = {
      lastCheckedAt: null, lastSuccessfulAt: null, domReady: null, errorCode: null,
      consecutiveSuccesses: 0, sessionId: session.sessionId, generation: session.generation,
    };
    socket.send(JSON.stringify({ kind: "hello", ok: true, port: this.#port, host: session }));
    if (this.#coordinator) void this.#refreshReconnectStatus();
  }

  async #withCepQueue<T>(work: () => Promise<T>): Promise<T> {
    this.#cepQueueDepth += 1;
    const previous = this.#cepTail;
    let release!: () => void;
    this.#cepTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try { return await work(); } finally { this.#cepQueueDepth -= 1; release(); }
  }
  async #withCepQueueBudget<T>(work: (remainingMs: number) => Promise<T>, budgetMs: number, timeoutCode: string): Promise<T> {
    this.#cepQueueDepth += 1;
    const previous = this.#cepTail;
    let release!: () => void;
    this.#cepTail = new Promise<void>((resolve) => { release = resolve; });
    const deadline = Date.now() + budgetMs;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const turn = previous.catch(() => undefined).then(async () => {
      if (timedOut) {
        this.#cepQueueDepth -= 1;
        release();
        return undefined as T;
      }
      const remainingMs = Math.max(1, deadline - Date.now());
      try {
        return await work(remainingMs);
      } finally {
        if (timer) clearTimeout(timer);
        this.#cepQueueDepth -= 1;
        release();
      }
    });
    const timeout = new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(codedError(timeoutCode, `Premiere mutation snapshot did not complete within ${budgetMs}ms total queue and execution time`));
      }, budgetMs);
    });
    return await Promise.race([turn, timeout]);
  }
  #validateMetadata(metadata: OperationWireMetadata, backend: "cep" | "uxp"): void {
    if (!metadata || typeof metadata !== "object" || !metadata.operationId || !metadata.toolName) {
      throw codedError("INVALID_OPERATION_METADATA", "operationId and toolName are required");
    }
    if (metadata.backend !== backend) throw codedError("OPERATION_BACKEND_MISMATCH", `Tagged ${backend} request declared backend '${metadata.backend}'`);
    if (metadata.mode !== "read" && metadata.mode !== "mutate") throw codedError("INVALID_OPERATION_METADATA", "Operation mode must be read or mutate");
  }
  #isCoordinatedMetadata(metadata: OperationWireMetadata | undefined): metadata is OperationWireMetadata & { toolName: string; backend: "cep" | "uxp"; mode: "read" | "mutate" } {
    return Boolean(metadata?.operationId && metadata.toolName && metadata.backend && metadata.mode);
  }

  async #dispatchExecute(source: WebSocket, req: ExecuteRequest): Promise<void> {
    const requestId: string = String(req.requestId ?? randomUUID());
    const timeoutMs = normalizeExecutionTimeout(req.timeoutMs);
    if (!this.#isCoordinatedMetadata(req.operation)) {
      if (this.#coordinator) {
        this.#sendFailure(source, requestId, "COORDINATED_OPERATION_REQUIRED", "This daemon requires begin_operation metadata before host execution");
        return;
      }
      try { await this.#withCepQueue(() => this.#executeCep(req.script, timeoutMs, requestId, source, "execute", req.operation)); } catch { /* response already sent */ }
      return;
    }
    try {
      if (!this.#coordinator) throw codedError("OPERATION_COORDINATOR_UNAVAILABLE", "Operation coordination is not enabled");
      this.#validateMetadata(req.operation, "cep");
      this.#coordinator.validateActiveRequest(req.operation.operationId, req.operation.toolName, req.operation.mode);
      const toolName = req.operation.toolName!;
      const mode = req.operation.mode!;
      const actual = payloadMetadata(req.script);
      if (req.operation.scriptBytes !== undefined && req.operation.scriptBytes !== actual.bytes) throw codedError("SCRIPT_METADATA_MISMATCH", "Declared script byte count does not match the transmitted script");
      if (req.operation.scriptSha256 !== undefined && req.operation.scriptSha256 !== actual.sha256) throw codedError("SCRIPT_METADATA_MISMATCH", "Declared script hash does not match the transmitted script");
      const target = this.#coordinator.snapshotTarget(req.operation.operationId);
      const hostScript = mode === "mutate" && target.requireActiveSequence && target.targetHint
        ? guardActiveSequenceScript(req.script, target.targetHint)
        : req.script;
      const hostScriptMetadata = payloadMetadata(hostScript);
      const data = await this.#coordinator.execute({
        operationId: req.operation.operationId, toolName, backend: "cep", mode,
        timeoutMs, script: { ...hostScriptMetadata, source: hostScript },
        executor: async () => {
          if (mode === "mutate") await this.#assertActiveSequenceTarget(req.operation!.operationId);
          return await this.#withCepQueue(() => this.#executeCep(hostScript, timeoutMs, undefined, null, "execute", req.operation, source));
        },
      });
      this.#sendSuccess(source, requestId, data, req.operation);
    } catch (error) { this.#sendOperationFailure(source, requestId, error, req.operation); }
  }

  async #dispatchHostProbe(source: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const requestId = String(msg.requestId ?? randomUUID());
    const timeoutMs = normalizeExecutionTimeout(msg.timeoutMs, 5_000);
    try {
      await this.#withCepQueue(() => this.#executeCep("", timeoutMs, undefined, null, "host_probe"));
      this.#sendSuccess(source, requestId, { connected: true, responsive: true, ...this.#hostSession });
    } catch (error) { this.#sendFailure(source, requestId, errorCode(error), (error as Error).message); }
  }

  async #dispatchDomReadinessProbe(source: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const requestId = String(msg.requestId ?? randomUUID());
    const timeoutMs = normalizeExecutionTimeout(msg.timeoutMs, 5_000);
    const checkedAt = new Date().toISOString();
    try {
      const raw = await this.#withCepQueue(() => this.#executeCep("", timeoutMs, undefined, null, "dom_readiness_probe"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as { ok?: unknown }).ok !== true) {
        throw codedError("DOM_READINESS_INVALID_RESPONSE", "Premiere DOM readiness probe returned an invalid payload");
      }
      const payload = raw as { projectOpen?: unknown; projectName?: unknown; activeSequence?: unknown };
      if (typeof payload.projectOpen !== "boolean"
        || (payload.projectName !== null && typeof payload.projectName !== "string")
        || (payload.activeSequence !== null && (typeof payload.activeSequence !== "object" || Array.isArray(payload.activeSequence)))) {
        throw codedError("DOM_READINESS_INVALID_RESPONSE", "Premiere DOM readiness probe returned an invalid payload");
      }
      const active = payload.activeSequence as { id?: unknown; name?: unknown } | null;
      if (active && !((typeof active.id === "string" || active.id === null) && (typeof active.name === "string" || active.name === null))) {
        throw codedError("DOM_READINESS_INVALID_RESPONSE", "Premiere DOM readiness probe returned invalid active-sequence data");
      }
      this.#domReadiness = {
        lastCheckedAt: checkedAt, lastSuccessfulAt: checkedAt, domReady: true, errorCode: null,
        consecutiveSuccesses: this.#domReadiness.consecutiveSuccesses + 1,
        sessionId: this.#hostSession?.sessionId ?? null, generation: this.#hostSession?.generation ?? null,
      };
      const result: DomReadinessProbeResult = {
        transportResponsive: true, domReady: true, projectOpen: payload.projectOpen,
        projectName: payload.projectName as string | null,
        activeSequence: active ? { id: active.id as string | null, name: active.name as string | null } : null,
        ...(this.#hostSession as HostSession),
      };
      this.#sendSuccess(source, requestId, result);
    } catch (error) {
      const code = errorCode(error) === "EXECUTION_TIMEOUT" ? "DOM_READINESS_TIMEOUT" : errorCode(error);
      this.#domReadiness = {
        ...this.#domReadiness, lastCheckedAt: checkedAt, domReady: false, errorCode: code,
        consecutiveSuccesses: 0, sessionId: this.#hostSession?.sessionId ?? null,
        generation: this.#hostSession?.generation ?? null,
      };
      this.#sendFailure(source, requestId, code, String((error as Error).message ?? error));
    }
  }

  async #dispatchUxp(source: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const requestId = String(msg.requestId ?? randomUUID());
    const metadata = msg.operationMetadata as OperationWireMetadata | undefined;
    const timeoutMs = normalizeExecutionTimeout(msg.timeoutMs, 30_000);
    const dispatch = async (): Promise<unknown> => {
      const bridge = this.#uxpBridge;
      if (!bridge || !bridge.connected) throw codedError("UXP_NOT_CONNECTED", "Premiere UXP panel is not connected to the bridge");
      const raw = await bridge.dispatch(String(msg.operation ?? ""), (msg.args ?? {}) as Record<string, unknown>, msg.expectedRevision as string | undefined, timeoutMs);
      const rec = raw as { success?: boolean; data?: unknown; error?: string; code?: string; outcomeUnknown?: boolean; dispatchState?: string };
      if (rec?.success === false) {
        const error = codedError(rec.code ?? "UXP_COMMAND_FAILED", rec.error ?? "UXP command failed") as Error & { outcomeUnknown?: boolean; dispatchState?: string };
        if (rec.outcomeUnknown === true) error.outcomeUnknown = true;
        if (rec.dispatchState) error.dispatchState = rec.dispatchState;
        throw error;
      }
      return rec?.data;
    };
    try {
      let data: unknown;
      if (this.#isCoordinatedMetadata(metadata)) {
        if (!this.#coordinator) throw codedError("OPERATION_COORDINATOR_UNAVAILABLE", "Operation coordination is not enabled");
        this.#validateMetadata(metadata, "uxp");
        this.#coordinator.validateActiveRequest(metadata.operationId, metadata.toolName, metadata.mode);
        const toolName = metadata.toolName!;
        const mode = metadata.mode!;
        if (mode === "mutate") await this.#assertActiveSequenceTarget(metadata.operationId);
        data = await this.#coordinator.execute({
          operationId: metadata.operationId, toolName, backend: "uxp", mode,
          timeoutMs, args: (msg.args ?? {}) as Record<string, unknown>, executor: async () => await dispatch(),
        });
      } else if (!this.#coordinator || String(msg.operation ?? "") === "uxp.catalog") {
        data = await dispatch();
      } else {
        throw codedError("COORDINATED_OPERATION_REQUIRED", "This daemon requires begin_operation metadata before UXP execution");
      }
      this.#sendSuccess(source, requestId, data, metadata);
    } catch (error) { this.#sendOperationFailure(source, requestId, error, metadata); }
  }

  async #beginOperation(source: WebSocket, req: BeginOperationWireRequest): Promise<void> {
    const requestId = String(req.requestId ?? randomUUID());
    try {
      if (!this.#coordinator) throw codedError("OPERATION_COORDINATOR_UNAVAILABLE", "Operation coordination is not enabled");
      const operationId = await this.#coordinator.beginOperation({
        ...(req.operationId ? { operationId: req.operationId } : {}), toolName: req.toolName, backend: req.backend, mode: req.mode,
        ...(req.targetHint ? { targetHint: req.targetHint } : {}), ...(req.targetKind ? { targetKind: req.targetKind } : {}),
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}), ...(req.queueDeadlineMs !== undefined ? { queueDeadlineMs: req.queueDeadlineMs } : {}),
        ...(req.args !== undefined ? { args: req.args } : {}), ...(req.itemCount !== undefined ? { itemCount: req.itemCount } : {}),
        ...(req.estimatedRiskyCalls !== undefined ? { estimatedRiskyCalls: req.estimatedRiskyCalls } : {}),
        ...(this.#hostSession ? { hostSession: this.#hostSession } : {}),
      }, req.mode === "mutate" ? () => this.#captureMutationPreflight(req.targetHint, req.targetKind, req.toolName) : undefined);
      const active: ActiveWireOperation = { source, mode: req.mode };
      this.#activeWireOperations.set(operationId, active);
      if (source.readyState !== source.OPEN) {
        await this.#finalizeOrphanOperation(operationId, active);
      } else {
        this.#sendSuccess(source, requestId, { operationId });
      }
    } catch (error) { this.#sendOperationFailure(source, requestId, error); }
  }

  async #endOperation(source: WebSocket, req: EndOperationWireRequest): Promise<void> {
    const requestId = String(req.requestId ?? randomUUID());
    try {
      if (!this.#coordinator) throw codedError("OPERATION_COORDINATOR_UNAVAILABLE", "Operation coordination is not enabled");
      const mode = this.#activeWireOperations.get(req.operationId)?.mode;
      const target = mode === "mutate" ? this.#coordinator.snapshotTarget(req.operationId) : null;
      const status = await this.#coordinator.endOperation(req.operationId, req.status,
        req.status === "SUCCEEDED" && mode === "mutate" && target
          ? () => this.#captureSnapshot(target.targetHint, target.targetKind, target.toolName)
          : undefined,
        req.failureCode);
      this.#sendSuccess(source, requestId, { operationId: req.operationId, status });
    } catch (error) {
      this.#sendOperationFailure(source, requestId, error);
    } finally {
      this.#activeWireOperations.delete(req.operationId);
    }
  }

  async #finalizeOrphanOperation(operationId: string, active: ActiveWireOperation): Promise<void> {
    if (this.#activeWireOperations.get(operationId) !== active) return;
    try {
      await this.#coordinator?.endOperation(
        operationId,
        active.mode === "mutate" ? "UNKNOWN" : "FAILED",
        undefined,
        "SOURCE_DISCONNECTED",
      );
    } catch {
      // Coordinator terminalization is idempotent. A concurrent explicit end
      // may win this race; either path still releases the tracked operation.
    } finally {
      if (this.#activeWireOperations.get(operationId) === active) this.#activeWireOperations.delete(operationId);
    }
  }

  async #operationStatus(source: WebSocket, requestId: string): Promise<void> {
    try {
      const recovery = this.#coordinator ? await this.#coordinator.getRecoveryStatus() : { quarantined: false, unresolved: [], cepQueueDepth: 0, mutationQueueDepth: 0 };
      this.#sendSuccess(source, requestId, {
        cep: { connected: this.#cepSocket !== null, identity: this.#hostSession?.identity ?? null }, uxp: { connected: this.#uxpBridge?.connected === true }, session: this.#hostSession,
        queue: { relayCepDepth: this.#cepQueueDepth, coordinatorCepDepth: recovery.cepQueueDepth, mutationDepth: recovery.mutationQueueDepth },
        quarantine: recovery.quarantined, quarantined: recovery.quarantined, unresolved: recovery.unresolved,
        reconciliation: [...this.#reconciliation.values()], modalState: "unknown",
        domReadiness: { ...this.#domReadiness },
        modalGuard: {
          supported: false,
          reason: "Premiere exposes no reliable generic modal-dialog state API",
          mutationPreflight: {
            mode: "responsive-evalscript",
            lastCheckedAt: this.#lastMutationPreflightAt,
            responsive: this.#lastMutationPreflightResponsive,
            errorCode: this.#lastMutationPreflightError,
          },
        },
        cepQueueDepth: recovery.cepQueueDepth, mutationQueueDepth: recovery.mutationQueueDepth,
      });
    } catch (error) { this.#sendOperationFailure(source, requestId, error); }
  }

  async #acknowledgeRecovery(source: WebSocket, req: AcknowledgeRecoveryWireRequest): Promise<void> {
    const requestId = String(req.requestId ?? randomUUID());
    try {
      if (!this.#coordinator) throw codedError("OPERATION_COORDINATOR_UNAVAILABLE", "Operation coordination is not enabled");
      const unresolved = (await this.#coordinator.getRecoveryStatus()).unresolved.find((item) => item.operationId === req.operationId);
      const current = await this.#captureSnapshot(
        unresolved?.resolvedSequenceId ?? unresolved?.target?.label,
        unresolved?.resolvedSequenceId ? "sequence" : unresolved?.target?.kind,
        unresolved?.toolName,
      );
      if (!req.expectedFingerprint || req.expectedFingerprint !== current.fingerprint) {
        throw codedError(
          "RECOVERY_FINGERPRINT_MISMATCH",
          `Recovery acknowledgement fingerprint mismatch; observedFingerprint=${current.fingerprint}`,
        );
      }
      await this.#coordinator.acknowledgeUnknown({ operationId: req.operationId, expectedFingerprint: req.expectedFingerprint, observedFingerprint: current.fingerprint });
      this.#reconciliation.delete(req.operationId);
      this.#sendSuccess(source, requestId, { operationId: req.operationId, observedFingerprint: current.fingerprint });
    } catch (error) { this.#sendOperationFailure(source, requestId, error); }
  }

  async #recoverySnapshot(source: WebSocket, requestId: string, operationId: string): Promise<void> {
    try {
      if (!this.#coordinator) throw codedError("OPERATION_COORDINATOR_UNAVAILABLE", "Operation coordination is not enabled");
      if (!operationId) throw codedError("RECOVERY_OPERATION_ID_REQUIRED", "A recovery operation id is required");
      const unresolved = (await this.#coordinator.getRecoveryStatus()).unresolved.find((item) => item.operationId === operationId);
      if (!unresolved) throw codedError("RECOVERY_OPERATION_NOT_UNRESOLVED", `Operation '${operationId}' is not unresolved`);
      const current = await this.#captureSnapshot(
        unresolved.resolvedSequenceId ?? unresolved.target?.label,
        unresolved.resolvedSequenceId ? "sequence" : unresolved.target?.kind,
        unresolved.toolName,
      );
      const comparison = await this.#coordinator.compareReconnect(operationId, current);
      this.#reconciliation.set(operationId, { operationId, state: comparison, observedFingerprint: current.fingerprint, checkedAt: new Date().toISOString() });
      this.#sendSuccess(source, requestId, { operationId, observedFingerprint: current.fingerprint, projectionVersion: current.projectionVersion, comparison });
    } catch (error) { this.#sendOperationFailure(source, requestId, error); }
  }

  async #captureSnapshot(targetHint?: string, targetKind?: string, toolName?: string, totalBudgetMs?: number): Promise<OperationSnapshot> {
    if (!this.#cepSocket || !this.#hostSession) throw codedError("HOST_NOT_CONNECTED", "Premiere Pro host is not connected for snapshot capture");
    const script = buildSnapshotScript(targetHint, targetKind, toolName);
    const raw = totalBudgetMs === undefined
      ? await this.#withCepQueue(() => this.#executeCep(script, this.#snapshotBudgetMs))
      : await this.#withCepQueueBudget(
          async (remainingMs) => await this.#executeCep(script, remainingMs),
          totalBudgetMs,
          "SNAPSHOT_PREFLIGHT_TIMEOUT",
        );
    type SnapshotPayload = { project?: unknown; projectState?: unknown; activeSequence?: { sequenceID?: unknown; name?: unknown }; targetSequence?: { sequenceID?: unknown; name?: unknown }; targetState?: unknown; coverage?: OperationSnapshot["coverage"]; snapshotError?: unknown };
    let parsed: SnapshotPayload | null = null;
    try {
      const candidate = typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) parsed = candidate as SnapshotPayload;
    } catch { /* The overall fingerprint still records an opaque host response. */ }
    if (parsed?.snapshotError) throw codedError("SNAPSHOT_TARGET_UNAVAILABLE", String(parsed.snapshotError));
    const projectState = parsed?.projectState ?? parsed?.project ?? null;
    const targetState = parsed?.targetState ?? parsed?.targetSequence ?? null;
    return {
      projectionVersion: 2,
      fingerprint: payloadMetadata(parsed ? { project: projectState, targetState } : raw).sha256,
      capturedAt: new Date().toISOString(),
      ...(projectState && typeof projectState === "object" ? { projectHash: payloadMetadata(projectState).sha256 } : {}),
      ...(targetState && typeof targetState === "object" ? { sequenceHash: payloadMetadata(targetState).sha256 } : {}),
      ...(parsed?.activeSequence?.sequenceID !== undefined ? { activeSequenceId: String(parsed.activeSequence.sequenceID) } : {}),
      ...(parsed?.targetSequence?.sequenceID !== undefined ? { resolvedSequenceId: String(parsed.targetSequence.sequenceID) } : {}),
      ...(parsed?.targetSequence?.name !== undefined ? { resolvedSequenceName: String(parsed.targetSequence.name) } : {}),
      ...(parsed?.coverage ? { coverage: parsed.coverage } : {}),
      hostSession: { ...this.#hostSession },
    };
  }
  async #captureMutationPreflight(targetHint?: string, targetKind?: string, toolName?: string): Promise<OperationSnapshot> {
    this.#lastMutationPreflightAt = new Date().toISOString();
    try {
      const snapshot = await this.#captureSnapshot(targetHint, targetKind, toolName, this.#snapshotBudgetMs);
      this.#lastMutationPreflightResponsive = true;
      this.#lastMutationPreflightError = null;
      return snapshot;
    } catch (error) {
      const code = errorCode(error);
      this.#lastMutationPreflightResponsive = false;
      this.#lastMutationPreflightError = code;
      if (/TIMEOUT|DISCONNECT|CLOSED|HOST_NOT_CONNECTED|HOST_REPLACED/.test(code)) {
        throw codedError("HOST_PREFLIGHT_BLOCKED", "Mutation refused because Premiere did not complete the responsive preflight; a modal dialog or blocked UI may be present");
      }
      throw error;
    }
  }
  async #assertActiveSequenceTarget(operationId: string): Promise<void> {
    if (!this.#coordinator) return;
    const target = this.#coordinator.snapshotTarget(operationId);
    if (!target.targetHint) return;
    const snapshot = await this.#captureSnapshot(target.targetHint, target.targetKind ?? "sequence", target.toolName);
    if (target.preSnapshot?.projectHash && snapshot.projectHash !== target.preSnapshot.projectHash) {
      throw codedError("PROJECT_IDENTITY_CHANGED", "Project identity changed after mutation preflight; dispatch refused");
    }
    if (target.preSnapshot?.resolvedSequenceId && snapshot.resolvedSequenceId !== target.preSnapshot.resolvedSequenceId) {
      throw codedError("SEQUENCE_IDENTITY_CHANGED", "Target sequence changed after mutation preflight; dispatch refused");
    }
    if (target.requireActiveSequence && snapshot.activeSequenceId !== target.targetHint) {
      throw codedError("ACTIVE_SEQUENCE_CHANGED", "Active sequence changed after operation preflight; UXP mutation refused");
    }
  }
  async #refreshReconnectStatus(): Promise<void> {
    if (!this.#coordinator) return;
    const recovery = await this.#coordinator.getRecoveryStatus();
    if (recovery.unresolved.length === 0) return;
    for (const unknown of recovery.unresolved) this.#reconciliation.set(unknown.operationId, { operationId: unknown.operationId, state: "PENDING" });
    try {
      for (const unknown of recovery.unresolved) {
        const snapshot = await this.#captureSnapshot(
          unknown.resolvedSequenceId ?? unknown.target?.label,
          unknown.resolvedSequenceId ? "sequence" : unknown.target?.kind,
          unknown.toolName,
        );
        const comparison = await this.#coordinator.compareReconnect(unknown.operationId, snapshot);
        this.#reconciliation.set(unknown.operationId, { operationId: unknown.operationId, state: comparison, observedFingerprint: snapshot.fingerprint, checkedAt: new Date().toISOString() });
      }
    } catch (error) {
      for (const unknown of recovery.unresolved) this.#reconciliation.set(unknown.operationId, { operationId: unknown.operationId, state: "FAILED", errorCode: errorCode(error), checkedAt: new Date().toISOString() });
    }
  }

  #executeCep(script: string, timeoutMs: number, requestId: string = randomUUID(), source: WebSocket | null = null, operation: "execute" | "host_probe" | "dom_readiness_probe" = "execute", metadata?: OperationWireMetadata, lateSource?: WebSocket): Promise<unknown> {
    const cepSocket = this.#cepSocket;
    if (!cepSocket) return Promise.reject(codedError("HOST_NOT_CONNECTED", "Premiere Pro host is not connected to the bridge"));
    return new Promise<unknown>((resolve, reject) => {
      if (!this.#reservePending(requestId, source, cepSocket, timeoutMs, operation, { resolve, reject }, metadata, lateSource)) return;
      cepSocket.send(JSON.stringify({ kind: operation, requestId, ...(operation === "execute" ? { script } : {}), timeoutMs, ...(metadata ? { operation: metadata } : {}) }));
    });
  }
  #reservePending(requestId: string, source: WebSocket | null, cepSocket: WebSocket, timeoutMs: number, operation: "execute" | "host_probe" | "dom_readiness_probe", callbacks: Pick<PendingEntry, "resolve" | "reject"> = {}, metadata?: OperationWireMetadata, lateSource?: WebSocket): boolean {
    if (this.#pending.has(requestId)) {
      const error = codedError("DUPLICATE_REQUEST", "A request with this id is already pending");
      if (source) this.#sendFailure(source, requestId, error.code, error.message); else callbacks.reject?.(error);
      return false;
    }
    const timer = setTimeout(() => {
      const entry = this.#pending.get(requestId);
      if (!entry) return;
      this.#pending.delete(requestId);
      const error = codedError("EXECUTION_TIMEOUT", `Premiere Pro did not respond within ${timeoutMs}ms`);
      entry.reject?.(error);
      if (entry.source) {
        this.#sendFailure(entry.source, requestId, error.code, error.message, entry.metadata, entry.operation === "execute");
      }
      if (entry.operation === "execute") this.#rememberLate(requestId, entry);
    }, timeoutMs);
    this.#pending.set(requestId, { timer, source, cepSocket, operation, ...(metadata ? { metadata } : {}), ...(lateSource ? { lateSource } : {}), ...callbacks });
    return true;
  }
  #relayResponse(cepSocket: WebSocket, msg: Record<string, unknown>): void {
    const requestId = String(msg.requestId ?? "");
    const entry = this.#pending.get(requestId);
    if (!entry || entry.cepSocket !== cepSocket) return;
    clearTimeout(entry.timer);
    this.#pending.delete(requestId);
    const responseError = msg.error as { code?: unknown; outcomeUnknown?: unknown; message?: unknown } | undefined;
    if (entry.operation === "execute" && (responseError?.outcomeUnknown === true || responseError?.code === "EXTENDSCRIPT_TIMEOUT")) this.#rememberLate(requestId, entry);
    const response = entry.operation === "host_probe" && msg.ok === true
      ? { kind: "response", requestId, ok: true, data: { connected: true, responsive: true, ...this.#hostSession } }
      : { ...msg, requestId, kind: "response", ...(entry.metadata ? { operation: entry.metadata } : {}) };
    if (msg.ok === true) entry.resolve?.((response as { data?: unknown }).data);
    else entry.reject?.(codedError(String(responseError?.code ?? "HOST_EXECUTION_FAILED"), String(responseError?.message ?? "Bridge execution failed")));
    const source = entry.source;
    if (source && source.readyState === source.OPEN) source.send(JSON.stringify(response));
  }
  #sendSuccess(source: WebSocket, requestId: string, data: unknown, operation?: OperationWireMetadata): void {
    if (source.readyState === source.OPEN) source.send(JSON.stringify({ kind: "response", requestId, ok: true, data, ...(operation ? { operation } : {}) }));
  }
  #sendOperationFailure(source: WebSocket, requestId: string, error: unknown, operation?: OperationWireMetadata): void {
    const unknown = error instanceof OperationExecutionUnknownError || errorCode(error) === "OPERATION_OUTCOME_UNKNOWN";
    this.#sendFailure(source, requestId, errorCode(error), String((error as Error)?.message ?? error), operation, unknown);
  }
  #sendFailure(source: WebSocket, requestId: string, code: string, message: string, operation?: OperationWireMetadata, outcomeUnknown = false): void {
    if (source.readyState !== source.OPEN) return;
    source.send(JSON.stringify({ kind: "response", requestId, ok: false, ...(operation ? { operation } : {}), error: { code, message, retryable: false, ...(outcomeUnknown ? { outcomeUnknown: true } : {}) } } satisfies ExecuteResponse));
  }
  #failPendingForCep(cepSocket: WebSocket, code: string, message: string): void {
    for (const [requestId, entry] of this.#pending) {
      if (entry.cepSocket !== cepSocket) continue;
      clearTimeout(entry.timer);
      this.#pending.delete(requestId);
      entry.reject?.(codedError(code, message));
      if (entry.source) this.#sendFailure(entry.source, requestId, code, message, entry.metadata, entry.operation === "execute");
    }
  }
  #rememberLate(requestId: string, entry: PendingEntry): void {
    const source = entry.lateSource ?? entry.source;
    if (!source) return;
    const previous = this.#late.get(requestId);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.#late.delete(requestId), 300_000);
    timer.unref();
    this.#late.set(requestId, { source, cepSocket: entry.cepSocket, ...(entry.metadata ? { operation: entry.metadata } : {}), timer });
  }
  #relayLateCompletion(cepSocket: WebSocket, msg: Record<string, unknown>): void {
    const requestId = String(msg.requestId ?? "");
    const entry = this.#late.get(requestId);
    if (!entry || entry.cepSocket !== cepSocket) return;
    clearTimeout(entry.timer);
    this.#late.delete(requestId);
    if (entry.source.readyState === entry.source.OPEN) entry.source.send(JSON.stringify({ ...msg, kind: "late_completion", requestId, ...(entry.operation ? { operation: entry.operation } : {}) }));
  }

  async request(script: string, args: Record<string, unknown> = {}, tool = "call"): Promise<unknown> {
    void args; void tool;
    return await this.#withCepQueue(() => this.#executeCep(script, normalizeExecutionTimeout(undefined)));
  }
  get connected(): boolean { return this.#cepSocket !== null; }
  get premiereConnected(): boolean { return this.#cepSocket !== null; }
  get port(): number { return this.#port; }
  async close(): Promise<void> {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    for (const entry of this.#pending.values()) { clearTimeout(entry.timer); entry.reject?.(codedError("DAEMON_CLOSED", "Bridge daemon closed during execution")); }
    this.#pending.clear();
    for (const entry of this.#late.values()) clearTimeout(entry.timer);
    this.#late.clear();
    await Promise.all([...this.#activeWireOperations].map(async ([operationId, active]) => {
      await this.#finalizeOrphanOperation(operationId, active);
    }));
    this.#activeWireOperations.clear();
    for (const client of this.#wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }
}

export function bridgeEndpointPath(): string { return endpointFile(); }
export function readBridgeEndpoint(): BridgeEndpoint | null {
  try {
    const parsed = JSON.parse(readFileSync(endpointFile(), "utf8")) as BridgeEndpoint;
    return parsed && typeof parsed.port === "number" && parsed.host === "127.0.0.1" && parsed.protocol === "ws" ? parsed : null;
  } catch { return null; }
}
export function daemonStateDir(): string { return stateDir(); }
export const daemonEndpointPath = endpointFile;
export const daemonPidFile = pidFile;
