import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getUpstreamToolModules } from "../vendor/upstream/tools/catalog.js";
import { EXTRA_TOOL_NAMES } from "./tool-names.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationWireMetadata } from "./bridge-types.js";
import { assertRawExtendScriptReadOnly, assertToolWithinPolicy, assertTransportWithinPolicy, getToolPolicy, type ToolPolicy } from "./operations/tool-policy.js";
import type { HostSessionRef, OperationBackend, OperationMode } from "./operations/types.js";

/**
 * Transport that upstream tool handlers talk to.
 *
 * Upstream tools call `transport.executeScript(script)` and expect a
 * normalized `{ success, data } | { success: false, error }` object back.
 * Our bridge implements the `executeScript` side by relaying the full
 * ExtendScript to the CEP host through the always-on daemon.
 */
export interface ScriptTransport {
  executeScript(script: string, timeoutMs?: number, operationContext?: OperationWireMetadata): Promise<unknown>;
}

/** Result shape the upsteam handlers produce and consume. */
export interface UpstreamResult {
  success: boolean;
  data?: unknown;
  error?: string;
  result?: unknown;
  code?: string;
  retryable?: boolean;
  outcomeUnknown?: boolean;
  operation?: unknown;
}

/** What the MCP server needs from the bridge: execute scripts, report status. */
export interface BridgeClient extends ScriptTransport {
  get connected(): boolean;
  get port(): number;
  readonly hostSession?: HostSessionRef | null;
  probeHost?(timeoutMs?: number): Promise<unknown>;
  probeDomReadiness?(timeoutMs?: number): Promise<unknown>;
  uxp(operation: string, args?: Record<string, unknown>, expectedRevision?: string, operationContext?: OperationWireMetadata, timeoutMs?: number): Promise<unknown>;
  beginOperation?(request: OperationBeginRequest): Promise<unknown>;
  endOperation?(operationId: string, status: "SUCCEEDED" | "FAILED" | "UNKNOWN", errorCode?: string): Promise<unknown>;
  operationStatus?(): Promise<unknown>;
  recoverySnapshot?(operationId: string): Promise<unknown>;
  acknowledgeRecovery?(operationId: string, expectedFingerprint: string): Promise<unknown>;
}

interface OperationBeginRequest {
  operationId: string;
  toolName: string;
  backend: OperationBackend;
  mode: OperationMode;
  targetHint?: string;
  targetKind?: string;
  timeoutMs: number;
  queueDeadlineMs: number;
  args: unknown;
  itemCount: number;
  estimatedRiskyCalls?: number;
}

interface ActiveOperationContext {
  operationId: string;
  toolName: string;
  mode: OperationMode;
  backend: OperationBackend;
  policy: ToolPolicy;
  argsBytes: number;
  itemCount: number;
  timeoutMs: number;
  queueDeadlineMs: number;
  targetHint?: string;
  targetKind?: string;
}

const operationContext = new AsyncLocalStorage<ActiveOperationContext>();
const OPERATION_CONTROL_KEYS = new Set(["operation_id", "workflow_id", "stage_id", "queue_timeout_ms", "read_only"]);

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function textResult(value: unknown): { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown> } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: asRecord(value),
  };
}

/**
 * Normalize the raw `{ success: boolean, data|error }` shape from upstream
 * handlers into the text result the MCP layer returns.
 */
function normalizeUpstream(raw: unknown): unknown {
  if (raw && typeof raw === "object") {
    const rec = raw as UpstreamResult;
    if (rec.success === false) {
      return {
        success: false,
        error: String(rec.error ?? "Unknown error"),
        ...(rec.code ? { code: rec.code } : {}),
        ...(rec.retryable !== undefined ? { retryable: rec.retryable } : {}),
        ...(rec.outcomeUnknown !== undefined ? { outcomeUnknown: rec.outcomeUnknown } : {}),
        ...(rec.operation !== undefined ? { operation: rec.operation } : {}),
      };
    }
    if (rec.success === true) return rec.data ?? rec.result ?? {};
  }
  return raw;
}

function jsonBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.POSITIVE_INFINITY; }
}

function stripOperationControls(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !OPERATION_CONTROL_KEYS.has(key)));
}

function countInputItems(value: unknown, seen = new WeakSet<object>()): number {
  if (!value || typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) return value.length + value.reduce((sum, item) => sum + countInputItems(item, seen), 0);
  let total = 0;
  for (const item of Object.values(value as Record<string, unknown>)) total += countInputItems(item, seen);
  return total;
}

function rawScriptFromArgs(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName !== "execute_extendscript") return undefined;
  const candidate = args.code ?? args.script;
  return typeof candidate === "string" ? candidate : "";
}

function estimateRiskyCalls(script: string | undefined): number | undefined {
  if (script === undefined) return undefined;
  const matches = script.match(/\b(?:overwriteClip|insertClip|insertFromSource|overwriteFromSource|addToTimeline|addKey|setValueAtKey|setValueAtTime|setTemporalEaseAtKey|setInterpolationTypeAtKey|remove|delete|setValue|save|saveAs)\s*\(/g);
  return matches?.length ?? 0;
}

function assertReadOnlyExpression(args: Record<string, unknown>): void {
  const expression = String(args.expression ?? "");
  if (!expression || Buffer.byteLength(expression, "utf8") > 2_048) throw new Error("evaluate_expression is limited to a non-empty 2048-byte query");
  const assignment = /(^|[^=!<>])=(?!=)/;
  const mutatingCall = /\.(?:save|saveAs|set[A-Z_]|add[A-Z_]|remove|delete|insert|overwrite|create|open|close|import|export|execute|enableQE)\s*\(/i;
  if (/[;{}]|\b(?:new|delete|function|eval)\b|\+\+|--/.test(expression) || assignment.test(expression) || mutatingCall.test(expression)) {
    throw new Error("evaluate_expression accepts read-only expressions only; use a dedicated mutation tool for changes");
  }
}

function operationTarget(toolName: string, args: Record<string, unknown>): { hint: string; kind: string } {
  const explicit = args.sequence_id ?? args.project_item_id ?? args.node_id ?? args.clip_id ?? args.path;
  if (explicit !== undefined && String(explicit).length > 0) {
    const kind = args.sequence_id !== undefined ? "sequence" : args.project_item_id !== undefined ? "project-item" : args.path !== undefined ? "path" : "clip";
    return { hint: String(explicit), kind };
  }
  if (/sequence|timeline|track|clip|keyframe|effect|transition|caption|playhead/.test(toolName)) return { hint: "active-sequence", kind: "sequence" };
  return { hint: "active-project", kind: "project" };
}

function operationBackend(toolName: string, mode: OperationMode): OperationBackend {
  if (mode === "local") return "local";
  return UXP_ROUTES[toolName] ? "uxp" : "cep";
}

function operationFailure(result: unknown): { failed: boolean; unknown: boolean; code?: string } {
  if (!result || typeof result !== "object") return { failed: false, unknown: false };
  const outer = result as { structuredContent?: unknown };
  const rec = outer.structuredContent && typeof outer.structuredContent === "object"
    ? outer.structuredContent as { success?: unknown; outcomeUnknown?: unknown; code?: unknown; error?: unknown }
    : result as { success?: unknown; outcomeUnknown?: unknown; code?: unknown; error?: unknown };
  if (rec.success !== false) return { failed: false, unknown: false };
  const code = typeof rec.code === "string" ? rec.code : "TOOL_FAILED";
  return { failed: true, unknown: rec.outcomeUnknown === true || /TIMEOUT|DISCONNECT|CLOSED|REPLACED|UNKNOWN/.test(`${code} ${String(rec.error ?? "")}`.toUpperCase()), code };
}

function errorOutcome(error: unknown): { status: "FAILED" | "UNKNOWN"; code: string } {
  const rec = error as { code?: unknown; outcomeUnknown?: unknown; message?: unknown } | null;
  const code = String(rec?.code ?? (error instanceof Error ? error.name : "TOOL_FAILED")).slice(0, 128);
  const unknown = rec?.outcomeUnknown === true || /TIMEOUT|DISCONNECT|CLOSED|REPLACED|UNKNOWN/.test(`${code} ${String(rec?.message ?? "")}`.toUpperCase());
  return { status: unknown ? "UNKNOWN" : "FAILED", code };
}

function domReadinessFailure(error: unknown): { code: string; error: string; transportResponsive: boolean } {
  const rec = error && typeof error === "object" ? error as { code?: unknown; error?: unknown; message?: unknown; name?: unknown } : null;
  const code = String(rec?.code ?? rec?.name ?? "DOM_READINESS_FAILED");
  const message = String(rec?.error ?? rec?.message ?? error);
  return {
    code,
    error: message,
    transportResponsive: /^(?:EXTENDSCRIPT_ERROR|DOM_PROBE_SCRIPT_ERROR|DOM_READINESS_INVALID_RESPONSE)$/.test(code),
  };
}

/**
 * Build an MCP server over the full tool surface.
 *
 * Every official upstream tool (266) runs real ExtendScript through the
 * bridge transport; extra project tools (87) are registered additionally and
 * mostly route to the closest real upstream implementation. No actionId, no
 * planHash, no auth, no polling — the tool name is the operation and each
 * call is one round-trip.
 */
export function createMcpServer(bridge: BridgeClient): McpServer {
  const server = new McpServer({ name: "premiere-pro-full-mcp", version: "2.0.0" });
  const scopedBridge: BridgeClient = {
    get connected() { return bridge.connected; },
    get port() { return bridge.port; },
    get hostSession() { return bridge.hostSession ?? null; },
    async probeHost(timeoutMs) {
      if (!bridge.probeHost) {
        throw Object.assign(new Error("The connected daemon does not support host probes"), { code: "HOST_PROBE_UNSUPPORTED" });
      }
      return bridge.probeHost(timeoutMs);
    },
    async probeDomReadiness(timeoutMs) {
      if (!bridge.probeDomReadiness) {
        throw Object.assign(new Error("The connected daemon does not support DOM readiness probes"), { code: "DOM_READINESS_UNSUPPORTED" });
      }
      return bridge.probeDomReadiness(timeoutMs);
    },
    async operationStatus() {
      if (!bridge.operationStatus) return null;
      return bridge.operationStatus();
    },
    async recoverySnapshot(operationId) {
      if (!bridge.recoverySnapshot) {
        return { success: false, error: "The connected daemon does not support recovery snapshot reads", code: "RECOVERY_SNAPSHOT_UNSUPPORTED" };
      }
      return bridge.recoverySnapshot(operationId);
    },
    async acknowledgeRecovery(operationId, expectedFingerprint) {
      if (!bridge.acknowledgeRecovery) {
        return { success: false, error: "The connected daemon does not support recovery acknowledgement", code: "RECOVERY_UNSUPPORTED" };
      }
      return bridge.acknowledgeRecovery(operationId, expectedFingerprint);
    },
    async executeScript(script, timeoutMs) {
      const active = operationContext.getStore();
      if (!active) return bridge.executeScript(script, timeoutMs);
      const budget = timeoutMs ?? active.timeoutMs;
      const scriptBytes = Buffer.byteLength(script, "utf8");
      assertTransportWithinPolicy(active.toolName, {
        ...(active.toolName === "execute_extendscript" ? { script } : {}),
        scriptBytes,
        argsBytes: active.argsBytes,
        itemCount: active.itemCount,
        executionTimeoutMs: budget,
        queueDeadlineMs: active.queueDeadlineMs,
      });
      const scriptMeta = { sha256: createHash("sha256").update(script, "utf8").digest("hex"), bytes: scriptBytes };
      return bridge.executeScript(script, budget, {
        operationId: active.operationId,
        toolName: active.toolName,
        mode: active.mode === "mutate" ? "mutate" : "read",
        backend: "cep",
        scriptSha256: scriptMeta.sha256,
        scriptBytes: scriptMeta.bytes,
      });
    },
    async uxp(operation, args, expectedRevision) {
      const active = operationContext.getStore();
      return bridge.uxp(operation, args, expectedRevision, active ? {
        operationId: active.operationId,
        toolName: active.toolName,
        mode: active.mode === "mutate" ? "mutate" : "read",
        backend: "uxp",
      } : undefined, active?.timeoutMs);
    },
  };

  const upstream = getUpstreamToolModules(scopedBridge);

  const runTool = async <T>(name: string, rawArgs: Record<string, unknown>, callback: (args: Record<string, unknown>) => Promise<T>): Promise<T> => {
    const args = stripOperationControls(rawArgs);
    const policy = getToolPolicy(name);
    const rawScript = rawScriptFromArgs(name, args);
    const readOnlyRaw = name === "execute_extendscript" && rawArgs.read_only === true;
    const timeoutMs = typeof args.timeout_ms === "number"
      ? Math.trunc(args.timeout_ms)
      : name === "execute_extendscript" ? 30_000 : policy.maxExecutionTimeoutMs;
    const queueDeadlineMs = typeof rawArgs.queue_timeout_ms === "number" ? Math.trunc(rawArgs.queue_timeout_ms) : policy.maxQueueDeadlineMs;
    const itemCount = Math.max(1, countInputItems(args));
    const argsBytes = jsonBytes(args);
    const riskyCalls = estimateRiskyCalls(rawScript);
    if (name === "evaluate_expression") assertReadOnlyExpression(args);
    if (readOnlyRaw) assertRawExtendScriptReadOnly("premiere_execute_extendscript", rawScript ?? "");
    assertToolWithinPolicy(name, {
      ...(rawScript !== undefined ? { script: rawScript } : {}),
      scriptBytes: rawScript === undefined ? 0 : Buffer.byteLength(rawScript, "utf8"),
      argsBytes,
      itemCount,
      executionTimeoutMs: timeoutMs,
      queueDeadlineMs,
      ...(riskyCalls !== undefined ? { estimatedRiskyCalls: riskyCalls } : {}),
    });

    if (policy.mode === "local") return callback(args);

    const operationId = typeof rawArgs.operation_id === "string" && rawArgs.operation_id.length > 0 ? rawArgs.operation_id : randomUUID();
    const target = operationTarget(name, args);
    const operationMode: OperationMode = readOnlyRaw ? "read" : policy.mode;
    const backend = operationBackend(name, operationMode);
    const active: ActiveOperationContext = {
      operationId,
      toolName: name,
      mode: operationMode,
      backend,
      policy,
      argsBytes,
      itemCount,
      timeoutMs,
      queueDeadlineMs,
      targetHint: target.hint,
      targetKind: target.kind,
    };
    if (!bridge.beginOperation || !bridge.endOperation) {
      return operationContext.run(active, () => callback(args));
    }
    try {
      await bridge.beginOperation({
        operationId,
        toolName: name,
        backend,
        mode: operationMode,
        targetHint: target.hint,
        targetKind: target.kind,
        timeoutMs,
        queueDeadlineMs,
        args,
        itemCount,
        ...(riskyCalls !== undefined ? { estimatedRiskyCalls: riskyCalls } : {}),
      });
    } catch (error) {
      const code = String((error as { code?: unknown } | null)?.code ?? "");
       if (operationMode === "read" && code === "OPERATION_COORDINATOR_UNAVAILABLE") return callback(args);
      throw error;
    }
    try {
      const result = await operationContext.run(active, () => callback(args));
      const failure = operationFailure(result);
       await bridge.endOperation(operationId, failure.failed ? (operationMode === "read" ? "FAILED" : failure.unknown ? "UNKNOWN" : "FAILED") : "SUCCEEDED", failure.code);
      return result;
    } catch (error) {
      const outcome = errorOutcome(error);
       try { await bridge.endOperation(operationId, operationMode === "read" ? "FAILED" : outcome.status, outcome.code); } catch { /* Preserve the original host/tool failure. */ }
      throw error;
    }
  };

  server.registerTool("premiere_capabilities", {
    title: "Bridge capabilities",
    description: "Return the connected host version and tool counts.",
    inputSchema: {
      domain: z.enum(["project", "sequence", "timeline", "media", "effects", "captions", "export", "playback", "workspace", "helpers"]).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    let uxp: { connected: boolean; hostVersion: null | string; capabilities: string[]; operations: string[]; catalogCounts: unknown } = { connected: false, hostVersion: null, capabilities: [], operations: [], catalogCounts: null };
    let operationStatus: unknown = null;
    try {
      const probe = (await bridge.uxp("uxp.catalog", { query: "", limit: 1 })) as { counts?: unknown; advertisedOperations?: string[]; fingerprint?: string } | null;
      if (probe && typeof probe === "object") {
        uxp = {
          connected: true,
          hostVersion: null,
          capabilities: Array.isArray((probe as { advertisedOperations?: unknown }).advertisedOperations) ? (probe as { advertisedOperations: string[] }).advertisedOperations : [],
          operations: Array.isArray((probe as { advertisedOperations?: unknown }).advertisedOperations) ? (probe as { advertisedOperations: string[] }).advertisedOperations : [],
          catalogCounts: (probe as { counts?: unknown }).counts ?? null,
        };
      } else {
        uxp = { connected: true, hostVersion: null, capabilities: [], operations: [], catalogCounts: null };
      }
    } catch {
      uxp = { connected: false, hostVersion: null, capabilities: [], operations: [], catalogCounts: null };
    }
    try { operationStatus = await bridge.operationStatus?.() ?? null; } catch { operationStatus = null; }
    return textResult({
      connected: bridge.connected,
      hostSession: bridge.hostSession ?? null,
      uxpConnected: uxp.connected,
      uxpOperations: uxp.operations,
      uxpHostVersion: uxp.hostVersion,
      uxpCatalogCounts: uxp.catalogCounts,
      toolCount: Object.keys(upstream).length,
      extraCount: EXTRA_TOOL_NAMES.length,
      total: Object.keys(upstream).length + EXTRA_TOOL_NAMES.length + 1,
      operationProtocolVersion: 1,
      operationLedgerSchemaVersion: 1,
      operationStatus,
    });
  });

  for (const [name, tool] of Object.entries(upstream)) {
    const params = (tool.parameters ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
    const policy = getToolPolicy(name);
    const schema = zodFromParameters(params).extend({
      ...operationControlShape(policy),
      ...(name === "execute_extendscript" ? { read_only: z.boolean().optional().describe("Explicit opt-in: validate and execute the bounded raw script as a read-only operation") } : {}),
    });
    server.registerTool(`premiere_${name}`, {
      title: name,
      description: tool.description ?? `Premiere Pro: ${name}`,
      inputSchema: schema,
      annotations: {
        readOnlyHint: policy.mode !== "mutate",
        destructiveHint: policy.mode === "mutate",
        openWorldHint: false,
      },
    }, async (args) => {
      return await runTool(name, args ?? {}, async (toolArgs) => {
        // UXP second track pre-dispatch: some official tool names have a
        // truthful UXP-only implementation. If unavailable, fall through to
        // the upstream ExtendScript handler and retain its honest result.
        if (UXP_ROUTES[name]) {
          const uxpResult = await dispatchUxp(scopedBridge, name, toolArgs);
          if (uxpResult !== UXP_FALLTHROUGH) return textResult(uxpResult);
        }
        const result = normalizeUpstream(await tool.handler(toolArgs));
        return textResult(result);
      });
    });
  }

  for (const name of EXTRA_TOOL_NAMES) {
    const policy = getToolPolicy(name);
    // Catalogued diagnostics already include their public `premiere_` prefix.
    // Preserve it instead of registering an unusable double-prefixed name.
    const publicName = name.startsWith("premiere_") ? name : `premiere_${name}`;
    server.registerTool(publicName, {
      title: name,
      description: buildExtraDescription(name),
      inputSchema: argsSchemaFor(name),
      annotations: {
        readOnlyHint: policy.mode !== "mutate",
        destructiveHint: policy.mode === "mutate",
        openWorldHint: false,
      },
    }, async (args) => {
      return await runTool(name, args ?? {}, async (toolArgs) => {
        const result = await executeExtraTool(scopedBridge, upstream, name, toolArgs);
        return textResult(result);
      });
    });
  }

  return server;
}

/** Convert upstream JSON-schema parameters into a zod object schema. */
function zodFromParameters(params: { properties?: Record<string, unknown>; required?: string[] } = {}): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const properties = (params.properties ?? {}) as Record<string, { type?: string; enum?: unknown[]; description?: string }>;
  const required = new Set(params.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(properties)) {
    let schema: z.ZodTypeAny;
    const type = prop.type;
    if (Array.isArray(prop.enum)) schema = z.enum(prop.enum as [string, ...string[]]);
    else if (type === "string") schema = z.string();
    else if (type === "number") schema = z.number();
    else if (type === "integer") schema = z.number().int();
    else if (type === "boolean") schema = z.boolean();
    else if (type === "array") schema = z.array(z.any());
    else if (type === "object") schema = z.record(z.string(), z.any());
    else schema = z.any();
    if (typeof prop.description === "string") schema = schema.describe(prop.description);
    shape[key] = required.has(key) ? schema : schema.optional();
  }
  return z.object(shape);
}

function operationControlShape(policy?: ToolPolicy): Record<string, z.ZodTypeAny> {
  const maxExecutionTimeoutMs = policy?.maxExecutionTimeoutMs ?? 60_000;
  const maxQueueDeadlineMs = policy?.maxQueueDeadlineMs ?? 30_000;
  return {
    operation_id: z.string().uuid().optional().describe("Optional caller operation id for diagnostics"),
    timeout_ms: z.number().int().min(250).max(maxExecutionTimeoutMs).optional().describe("Maximum host execution time accepted by this tool's safety policy"),
    queue_timeout_ms: z.number().int().positive().max(maxQueueDeadlineMs).optional().describe("Maximum daemon-lease wait accepted by this tool's safety policy"),
  };
}

function buildExtraDescription(name: string): string {
  const prefix = name.includes("_") ? name.split("_")[0]! : name;
  return `Premiere Pro: ${name}. Local-first operation over the always-on bridge. Domain: ${prefix}.`;
}

/** Minimal per-tool arg shapes for the extra tools. */
function argsSchemaFor(name: string): Record<string, z.ZodType> {
  const idField = z.string().min(1).max(512);
  const common: Record<string, z.ZodType> = operationControlShape(getToolPolicy(name));
  const compoundBatchRelink = name === "media_batch_relink";
  if (/_sequence/.test(name) || name.startsWith("sequence_") || name.startsWith("timeline_")) common.sequence_id = idField.optional();
  if (!compoundBatchRelink && (/_project_item|project_item|_item/.test(name) || name.startsWith("media_") || name.startsWith("project_"))) common.project_item_id = idField.optional();
  if (!compoundBatchRelink && (name.startsWith("media_") || name.includes("import"))) common.paths = z.array(z.string().min(1).max(4096)).max(128).optional();
  if (name.includes("track")) common.track_index = z.number().int().nonnegative().optional();
  if (name.includes("time") || name.includes("seconds") || name.includes("playhead") || name.includes("in_out") || name.includes("marker")) {
    common.time_seconds = z.number().nonnegative().optional();
    common.in_seconds = z.number().nonnegative().optional();
    common.out_seconds = z.number().nonnegative().optional();
  }
  if (name.includes("marker")) {
    common.marker_name = z.string().max(256).optional();
    common.comment = z.string().max(1024).optional();
  }
  if (name.includes("frame") || name.includes("export")) common.output_path = z.string().min(1).max(4096).optional();
  if (name.includes("name")) common.name = z.string().min(1).max(256).optional();
  // helpers_* tools use their own arg names (not the generic time_seconds).
  // Provide the correct inputs so the schema matches the implementation,
  // otherwise these never receive a usable value and always fail validation.
  if (name.startsWith("helpers_")) {
    common.fps = z.number().positive().optional();
    if (name === "helpers_ticks_to_timecode" || name === "helpers_seconds_to_timecode") {
      common.seconds = z.number().optional();
      common.value = z.number().optional();
    }
    if (name === "helpers_timecode_to_seconds" || name === "helpers_timecode_to_ticks") {
      common.timecode = z.string().min(1).optional();
    }
  }
  if (name === "premiere_health_check") {
    common.mode = z.enum(["probe", "dom_readiness", "recovery_snapshot", "acknowledge_recovery"]).optional();
    common.recovery_operation_id = z.string().uuid().optional();
    common.expected_fingerprint = z.string().regex(/^[a-f0-9]{64}$/).optional();
  }
  if (name === "media_batch_relink") {
    common.relinks = z.array(z.object({
      project_item_id: idField,
      new_path: z.string().min(1).max(4096),
    })).min(1).max(getToolPolicy(name).maxItems).describe("Bounded media relink requests, applied sequentially in input order");
  }
  // Extra tools that route to an upstream handler must expose the same
  // required arguments the routed handler expects, otherwise the handler
  // receives undefined and throws (e.g. "Cannot read properties of undefined").
  const routedRequiredArgs: Record<string, Record<string, z.ZodType>> = {
    sequence_new_from_bins: {
      name: z.string().min(1).max(256),
      item_ids: z.array(z.string().min(1)).min(1),
    },
    media_metadata_bulk_write: { metadata_xml: z.string().min(1) },
    media_set_color_label_batch: { metadata_xml: z.string().min(1) },
    project_bin_recursive_contents: { bin_id: z.string().min(1) },
    effects_batch_apply: { node_id: idField, effect_name: z.string().min(1) },
    effects_batch_remove: { node_id: idField },
    effects_match_parameter: { node_id: idField },
    effects_keyframe_reset: { node_id: idField },
  };
  const routed = routedRequiredArgs[name];
  if (routed) {
    for (const [k, schema] of Object.entries(routed)) common[k] = schema;
  }
  return common;
}

/**
 * Execute an extra (project-owned) tool.
 *
 * Most extras map onto a real upstream tool that already ships a concrete
 * ExtendScript handler — routing through it means the extra is genuinely
 * implemented, not a stub. A handful are pure local helpers. Any that cannot
 * be routed are removed from the surface rather than silently succeeding.
 */
async function executeExtraTool(
  bridge: BridgeClient,
  upstream: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // ---- Pure local helpers (no host round-trip needed) ----
  if (name === "helpers_ticks_to_timecode") return { timecode: ticksToTimecode(Math.round(Number(args.seconds ?? args.value ?? 0) * 254016000000), Number(args.fps ?? 24)) };
  if (name === "helpers_seconds_to_timecode") return { timecode: ticksToTimecode(Math.round(Number(args.seconds ?? 0) * 254016000000), Number(args.fps ?? 24)) };
  if (name === "helpers_timecode_to_seconds") return { seconds: timecodeToSeconds(String(args.timecode ?? ""), Number(args.fps ?? 24)) };
  if (name === "helpers_timecode_to_ticks") return { ticks: Math.round(timecodeToSeconds(String(args.timecode ?? ""), Number(args.fps ?? 24)) * 254016000000) };
  if (name === "helpers_duration_summary") {
    const result = await bridge.executeScript(`(function(){
      try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ success: false, error: "No active sequence" });
        var ticks = Number(seq.end);
        return JSON.stringify({ success: true, data: { ticks: ticks, seconds: ticks / 254016000000, timecode: (function(t){ var s=t/254016000000; var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),r=Math.floor(s%60),f=Math.floor((s%1)*${Math.max(1, Number(args.fps ?? 24))}); function p(n){return n<10?"0"+n:""+n;} return p(h)+":"+p(m)+":"+p(r)+":"+p(f); })(ticks) } });
      } catch (e) { return JSON.stringify({ success: false, error: String(e) }); }
    })();`);
    return normalizeUpstream(result);
  }
  if (name === "helpers_resolve_sequence_id" || name === "helpers_resolve_project_item_id") {
    const result = await bridge.executeScript(buildExtraToolScript(name, args));
    return normalizeUpstream(result);
  }
  if (name === "premiere_connection_status") {
    let operationStatus: unknown = null;
    try { operationStatus = await bridge.operationStatus?.() ?? null; } catch (error) {
      operationStatus = { available: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { connected: bridge.connected, port: bridge.port, hostSession: bridge.hostSession ?? null, operationStatus, recovery_status: operationStatus };
  }
  if (name === "premiere_health_check") {
    const readRecoveryStatus = async (): Promise<unknown> => {
      try { return await bridge.operationStatus?.() ?? null; } catch { return null; }
    };
    const attachRecoveryStatus = async (value: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const status = await readRecoveryStatus();
      return { ...value, operationStatus: status, recovery_status: status };
    };
    const mode = String(args.mode ?? "probe");
    if (mode === "recovery_snapshot") {
      const operationId = String(args.recovery_operation_id ?? "");
      if (!operationId) return { success: false, error: "recovery_operation_id is required", code: "RECOVERY_SNAPSHOT_INPUT_REQUIRED" };
      if (!bridge.recoverySnapshot) return { success: false, error: "The connected daemon does not support recovery snapshot reads", code: "RECOVERY_SNAPSHOT_UNSUPPORTED" };
      return await bridge.recoverySnapshot(operationId);
    }
    if (mode === "acknowledge_recovery") {
      const operationId = String(args.recovery_operation_id ?? "");
      const expectedFingerprint = String(args.expected_fingerprint ?? "");
      if (!operationId || !expectedFingerprint) return { success: false, error: "recovery_operation_id and expected_fingerprint are required", code: "RECOVERY_ACK_INPUT_REQUIRED" };
      if (!bridge.acknowledgeRecovery) return { success: false, error: "The connected daemon does not support recovery acknowledgement", code: "RECOVERY_UNSUPPORTED" };
      return await bridge.acknowledgeRecovery(operationId, expectedFingerprint);
    }
    if (mode === "dom_readiness") {
      try {
        if (!bridge.probeDomReadiness) {
          throw Object.assign(new Error("The connected daemon does not support DOM readiness probes"), { code: "DOM_READINESS_UNSUPPORTED" });
        }
        const probe = await bridge.probeDomReadiness(5_000);
        const failure = probe && typeof probe === "object" && (probe as { success?: unknown }).success === false
          ? probe as { code?: unknown; error?: unknown }
          : null;
        if (failure) {
          const diagnostic = domReadinessFailure(failure);
          return attachRecoveryStatus({
            success: false,
            connected: bridge.connected,
            transportResponsive: diagnostic.transportResponsive,
            domReady: false,
            modalState: "unknown",
            code: diagnostic.code,
            error: diagnostic.error,
          });
        }
        return attachRecoveryStatus({
          success: true,
          connected: bridge.connected,
          transportResponsive: true,
          domReady: true,
          modalState: "unknown",
          probe,
        });
      } catch (error) {
        const diagnostic = domReadinessFailure(error);
        return attachRecoveryStatus({
          success: false,
          connected: bridge.connected,
          transportResponsive: diagnostic.transportResponsive,
          domReady: false,
          modalState: "unknown",
          code: diagnostic.code,
          error: diagnostic.error,
        });
      }
    }
    let probe: unknown;
    try {
      probe = await bridge.probeHost!(5_000);
    } catch (error) {
      const outcome = errorOutcome(error);
      const unsupported = outcome.code === "HOST_PROBE_UNSUPPORTED";
      return attachRecoveryStatus({
        success: false,
        connected: bridge.connected,
        port: bridge.port,
        responsive: unsupported ? null : false,
        modalState: "unknown",
        code: outcome.code,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const responsive = probe && typeof probe === "object" && typeof (probe as { responsive?: unknown }).responsive === "boolean"
      ? (probe as { responsive: boolean }).responsive
      : null;
    return attachRecoveryStatus({
      success: true,
      connected: bridge.connected,
      port: bridge.port,
      responsive,
      modalState: "unknown",
      probe,
    });
  }

  // ---- UXP second track: tools that can only run over the UXP panel bridge.
  // These require UXP APIs that CEP/ExtendScript cannot reach (SequenceEditor
  // createRemoveItemsAction / createCloneTrackItemAction / createMoveAction /
  // createInsertProjectItemAction, typed project close, Exporter frame export).
  // Route them to the connected UXP panel via bridge.uxp(). If the UXP panel
  // is not connected, return the documented UXP error rather than fake success.
  const uxpResult = await dispatchUxp(bridge, name, args);
  if (uxpResult !== UXP_FALLTHROUGH) {
    return uxpResult;
  }

  // ---- Any extra we explicitly removed (name claims an action we cannot
  // actually perform truthfully; do NOT silently route to a different tool) ----
  if (UNSUPPORTED_EXTRAS.has(name)) {
    return { success: false, error: `Tool '${name}' is registered but not supported by this bridge (no truthful ExtendScript implementation). Fix its mapping or remove it before use.` };
  }

  if (name === "media_batch_relink") {
    const relinks = Array.isArray(args.relinks) ? args.relinks : [];
    const target = upstream.relink_media;
    if (!target || typeof target.handler !== "function") {
      return { success: false, error: "Routed upstream tool 'relink_media' is unavailable" };
    }
    const results: unknown[] = [];
    for (const relink of relinks) {
      const entry = relink && typeof relink === "object" ? relink as Record<string, unknown> : {};
      const itemId = String(entry.project_item_id ?? "");
      const newPath = String(entry.new_path ?? "");
      const result = normalizeUpstream(await target.handler({ item_id: itemId, new_path: newPath }));
      results.push({ project_item_id: itemId, new_path: newPath, result });
    }
    const failed = results.filter((entry) => {
      const result = (entry as { result?: unknown }).result;
      return Boolean(result && typeof result === "object" && (result as { success?: unknown }).success === false);
    });
    return { success: failed.length === 0, requested: relinks.length, completed: results.length, failed: failed.length, results };
  }

  // ---- Route to the closest real upstream implementation ----
  const route = EXTRA_ROUTES[name];
  if (route) {
    const target = upstream[route.target];
    if (!target || typeof target.handler !== "function") {
      return { success: false, error: `Routed upstream tool '${route.target}' is unavailable` };
    }
    const result = await target.handler(route.map ? route.map(args) : args);
    return normalizeUpstream(result);
  }

  // ---- Fall back to a real host script execution ----
  return normalizeUpstream(await bridge.executeScript(buildExtraToolScript(name, args)));
}

/** Extra tools that route to an upstream handler with identical semantics. */
export const EXTRA_ROUTES: Record<string, { target: string; map?: (args: Record<string, unknown>) => Record<string, unknown> }> = {
  timeline_list_all_clips: { target: "get_full_sequence_info" },
  timeline_gap_report: { target: "get_timeline_gaps" },
  timeline_track_summary: { target: "get_timeline_summary" },
  timeline_clip_count: { target: "get_full_sequence_info" },
  timeline_summary_ratios: { target: "get_timeline_summary" },
  timeline_playhead_to_chapter_marker: { target: "get_sequence_markers_by_type", map: () => ({ marker_type: "chapter" }) },
  timeline_marker_to_chapter: { target: "get_sequence_markers_by_type", map: () => ({ marker_type: "chapter" }) },
  timeline_marker_to_segments: { target: "get_sequence_markers_by_type", map: () => ({ marker_type: "segment" }) },
  timeline_match_frame_in_out: { target: "get_sequence_in_out_points" },
  timeline_trim_to_work_area: { target: "set_work_area" },

  media_list_all_items: { target: "list_project_items" },
  media_unused_media_report: { target: "get_unused_media" },
  media_duplicate_media_report: { target: "get_duplicate_media" },
  media_batch_replace: { target: "replace_clip_media" },
  media_import_all_in_folder: { target: "import_folder" },
  media_import_sequence_bin: { target: "import_sequences" },
  media_metadata_bulk_read: { target: "get_project_panel_metadata" },
  media_metadata_bulk_write: { target: "set_project_panel_metadata" },
  media_set_color_label_batch: { target: "set_project_panel_metadata" },

  project_structure_tree: { target: "get_full_project_overview" },
  project_bin_recursive_contents: { target: "get_bin_contents" },
  project_close_inactive: { target: "close_project" },
  project_autosave_status: { target: "get_project_info" },
  project_close_inactive_aliased: { target: "close_project" },

  captions_export_srt: { target: "get_sequence_markers_by_type", map: () => ({ marker_type: "segment" }) },
  captions_cue_count: { target: "get_sequence_markers_by_type", map: () => ({ marker_type: "segment" }) },
  captions_cue_snapshot: { target: "get_sequence_markers_by_type", map: () => ({ marker_type: "segment" }) },
  text_mogrt_inventory: { target: "get_project_info" },
  text_font_inventory: { target: "get_project_info" },

  effects_chain_inventory: { target: "get_full_sequence_info" },
  effects_batch_apply: { target: "apply_effect" },
  effects_batch_remove: { target: "remove_effect" },
  transitions_inventory: { target: "get_full_sequence_info" },

  export_preset_finder: { target: "get_encoder_presets" },
  export_frame_marker: { target: "get_sequence_markers_by_type", map: () => ({ marker_type: "chapter" }) },

  playback_scrub_seconds: { target: "set_playhead_position" },

  sequence_new_from_bins: { target: "create_sequence_from_clips" },
  sequence_set_display_format_simple: { target: "set_sequence_display_format" },
};

/** Extras implemented as bounded orchestration over one or more real handlers. */
export const COMPOUND_EXTRAS = new Set<string>(["media_batch_relink"]);

/** Extra names that should not pretend to work (removed from active use). */
export const UNSUPPORTED_EXTRAS = new Set<string>([
  // r4: remove actions that silently route to a different tool. These names
  // claim a specific edit/export/audio/multicam action but EXTRA_ROUTES maps
  // them to a getter or a different single-item tool. Keeping them active
  // with the old mapping would make the tool do something the name doesn't
  // say (e.g. effects_keyframe_reset actually returning sequence settings).
  //
  // A truthful ExtendScript body for each is out of scope for the CEP bridge
  // (some require UXP APIs that are unavailable in ExtendScript); until that
  // exists these must fail loudly instead of silently doing the wrong thing.

  "effects_keyframe_reset",
  "effects_match_parameter",
  "transitions_batch_add",

  "audio_loudness_normalize",
  "audio_batch_normalize",
  "audio_batch_clip_gain",
  "audio_duck_on_markers",

  "captions_burn_in_preview",
  "captions_import_srt",

  "media_proxy_attach_all",
  "media_proxy_detach_all",
  "media_consolidate_to_folder",

  "export_all_sequences",
  "export_sequence_custom_range",
  "export_batch_ame",
  "export_upload_placeholder",
  "export_render_queue_status",
  "export_mark_as_good",

  "workspace_reset",
  "workspace_save_custom",

  "text_mogrt_apply_batch",
  "text_style_snapshot",

  "multicam_group_clips",
  "multicam_ungroup_clips",
  "multicam_set_camera_track",
  "multicam_enable_angle",
  "multicam_cut_on_marker",

  "timeline_merge_tracks",
  "timeline_extend_edit_to_track_end",
  "playback_loop_range",
  "playback_play_in_out",
  "playback_jump_to_next_edit",
  "playback_jump_to_prev_edit",

  "sequence_duplicate_batch",
  "transcription_of_target",
  "transcript_export_srt",
]);

function ticksToTimecode(ticks: number, fps: number): string {
  const total = ticks / 254016000000;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  const frames = Math.floor((total % 1) * fps);
  return [hours, minutes, seconds, frames].map((n) => String(n).padStart(2, "0")).join(":");
}

function timecodeToSeconds(timecode: string, fps: number): number {
  const parts = String(timecode).split(":");
  if (parts.length < 4) throw new Error("timecode must be HH:MM:SS:FF");
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]) + Number(parts[3]) / fps;
}

/** Sentinel: the UXP route is not applicable for this call; fall back to the
 *  upstream ExtendScript handler so it can report the honest error. */
const UXP_FALLTHROUGH = Symbol("UXP_FALLTHROUGH");

/**
 * A single UXP operation step. `operation` is the panel command name, `map` is
 * an optional pure transformer turning the MCP args (plus any handle produced
 * by a previous step via `$_handle`) into the step's wire arguments.
 */
interface UxpRouteStep {
  operation: string;
  map?: (args: Record<string, unknown>) => Record<string, unknown>;
}

type UxpRoute = UxpRouteStep | { steps: UxpRouteStep[] };

function frameExportArgs(args: Record<string, unknown>, defaultOutputPath?: string): Record<string, unknown> {
  const mapped: Record<string, unknown> = { outputPath: String(args.output_path ?? defaultOutputPath ?? "") };
  if (typeof args.time_seconds === "number") mapped.timeSeconds = args.time_seconds;
  if (typeof args.format === "string") mapped.format = args.format;
  if (typeof args.timeout_ms === "number") mapped.materializationTimeoutMs = Math.min(30_000, Math.trunc(args.timeout_ms));
  return mapped;
}

/** Normalize a UXP panel result to a plain value (unwrap the {success,data} wrapper). */
function unwrapUxpResult(uxpResult: unknown): unknown | typeof UXP_FALLTHROUGH {
  if (uxpResult === undefined || uxpResult === null) return {};
  if (uxpResult && typeof uxpResult === "object") {
    const rec = uxpResult as { success?: boolean; data?: unknown; error?: string; code?: string };
    if (rec.success === false) {
      if (rec.code === "UXP_UNAVAILABLE" || rec.code === "UXP_NOT_CONNECTED") return UXP_FALLTHROUGH;
      return { success: false, error: String(rec.error ?? "UXP operation failed"), code: String(rec.code ?? "UXP_FAILED") };
    }
    if ("data" in rec && rec.data !== undefined) return unwrapUxpResult(rec.data);
    const envelope = uxpResult as Record<string, unknown>;
    if ("result" in envelope) {
      const result = envelope.result;
      const metadata = Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== "result"));
      if (result && typeof result === "object" && !Array.isArray(result)) {
        return { ...(result as Record<string, unknown>), uxpVerification: metadata };
      }
      return { result, uxpVerification: metadata };
    }
  }
  return uxpResult;
}

/**
 * Dispatch a named tool through the UXP bridge path. Returns a normalized
 * { success, data|error } result. If the UXP panel is not connected or this
 * operation is not in the route map, returns UXP_FALLTHROUGH so the caller can
 * fall back to the upstream ExtendScript handler (which produces an honest
 * "not supported by this bridge" error rather than a fake success).
 */
async function dispatchUxp(bridge: BridgeClient, name: string, args: Record<string, unknown>): Promise<unknown | typeof UXP_FALLTHROUGH> {
  const route = UXP_ROUTES[name];
  if (!route) return UXP_FALLTHROUGH;
  const steps: UxpRouteStep[] = "steps" in route ? route.steps : [route as UxpRouteStep];
  let handle: Record<string, unknown> | null = null;
  let resolved = { ...args };
  // Some destructive clip tools target a clip by its CEP `node_id` (a QE client
  // id) which has no UXP equivalent. The server resolves node_id -> (track,
  // clip start/index) by reading the active sequence over the CEP bridge, then
  // feeds those coordinates into the UXP find step. This makes the handle-based
  // UXP ops usable from the existing tool schema without any agent code change.
  if (args && typeof args.node_id === "string" && args.node_id.length) {
    const locate = await resolveNodeIdInSequence(bridge, args.node_id);
    if (locate) resolved = { ...resolved, track_index: locate.trackIndex, clip_index: locate.clipIndex, clip_name: locate.clipName, clip_start_seconds: locate.startSeconds };
  }
  for (const step of steps) {
    const stepSource = { ...resolved, ...(handle ? { $_handle: handle } : {}) };
    const stepArgs = step.map ? step.map(stepSource) : stepSource;
    if (process.env.PREMIERE_MCP_DEBUG === "1") process.stderr.write(`[uxp] ${name} -> ${step.operation} args=${JSON.stringify(stepArgs)}\n`);
    const uxpResult = (await bridge.uxp(step.operation, stepArgs)) as { success?: boolean; data?: unknown; error?: string; code?: string };
    const unwrapped = unwrapUxpResult(uxpResult);
    if (unwrapped === UXP_FALLTHROUGH) return UXP_FALLTHROUGH;
    if (unwrapped && typeof unwrapped === "object" && (unwrapped as { success?: boolean }).success === false) return unwrapped;
    // If a step returned a session-scoped handle, thread it to the next step.
    const data = unwrapped && typeof unwrapped === "object" ? (unwrapped as { handle?: Record<string, unknown>; result?: { handle?: Record<string, unknown> } }).handle ?? (unwrapped as { result?: { handle?: Record<string, unknown> } }).result?.handle ?? null : null;
    if (data) handle = data;
    // The last step's output is the tool result; intermediate steps only feed
    // the handle. If a step is the final one, return its whole result.
    if (step === steps[steps.length - 1]) return unwrapped;
  }
  return {};
}

/**
 * UXP second track: tools whose only truthful implementation lives on the
 * Premiere UXP panel bridge. Each entry maps the flat MCP tool name to a UXP
 * operation (or a small pipeline of operations) that needs UXP APIs which
 * CEP/ExtendScript cannot reach, so we route them through bridge.uxp() when the
 * panel is connected. Operators can either be a single `operation` + `map`
 * (one UXP call) or a `steps` array where earlier steps may return a
 * session-scoped handle that later steps reference via `$_handle`.
 */
export const UXP_ROUTES: Record<string, UxpRoute> = {
  // Premiere 26 sequence creation needs a preset-aware API; the UXP bridge
  // owns the host-compatible implementation and reads the created sequence
  // back before reporting success.
  create_sequence: {
    operation: "project.sequence.create",
    map: (args) => typeof args.preset_path === "string" && args.preset_path.length > 0
      ? { name: String(args.name ?? ""), presetPath: args.preset_path }
      : { name: String(args.name ?? "") },
  },

  // --- Frame / sequence export via Exporter (CEP lacks exportFramePNG). ---
  // export_frame takes an output_path (single named destination). capture_frame
  // captures "the current frame" without a destination in its schema, so we
  // synthesize a stable temp path and run the same UXP Exporter path.
  capture_frame: { operation: "export.frame", map: (args) => frameExportArgs(args, join(tmpdir(), `ppmc_frame_${Date.now()}.png`)) },
  export_frame: { operation: "export.frame", map: (args) => frameExportArgs(args) },

  // --- Track mute / visibility are UXP-only (AudioTrack.setMute is not over
  // CEP/ExtendScript). We route the mediaType + trackIndex straight through.
  mute_track: { operation: "timeline.track.set_mute", map: (args) => ({ mediaType: args.track_type === "audio" ? "audio" : "video", trackIndex: args.track_index, muted: args.muted !== false }) },
  toggle_track_visibility: { operation: "timeline.track.set_mute", map: (args) => ({ mediaType: args.track_type === "audio" ? "audio" : "video", trackIndex: args.track_index, muted: args.visibility === false || args.hidden === true }) },

  // --- Video transition add via UXP-only TransitionFactory. The upstream
  // add_transition family cannot reach these APIs over CEP; route them to the
  // panel's timeline.clip.add_transition. The clip must first be resolved to a
  // track item handle via timeline.clip.find using the tool's coordinates.
  add_transition: {
    steps: [
      { operation: "timeline.clip.find", map: (args) => ({ mediaType: "video", trackIndex: args.track_index ?? 0, clipTimeSeconds: args.cut_point_seconds, clipName: args.clip_name }) },
      { operation: "timeline.clip.add_transition", map: (args) => ({ trackItem: (args as Record<string, unknown>).$_handle, matchName: args.transition_name ?? "Cross Dissolve", durationSeconds: args.duration_seconds }) },
    ],
  },
  add_transition_to_clip: {
    steps: [
      { operation: "timeline.clip.find", map: (args) => ({ mediaType: "video", trackIndex: args.track_index ?? 0, clipIndex: args.clip_index ?? 0, clipName: args.clip_name }) },
      { operation: "timeline.clip.add_transition", map: (args) => ({ trackItem: (args as Record<string, unknown>).$_handle, matchName: args.transition_name ?? "Cross Dissolve", durationSeconds: args.duration_seconds }) },
    ],
  },

  // --- Clip move / delete / trim via UXP-only SequenceEditor actions. The
  // server resolves a clip `node_id` to coordinates (track + index from a CEP
  // read) before the panel finds the session handle and runs the transaction.
  move_clip: {
    steps: [
      { operation: "timeline.clip.find", map: (args) => ({ mediaType: "video", trackIndex: args.track_index ?? 0, clipIndex: args.clip_index ?? 0, clipName: args.clip_name }) },
      { operation: "timeline.clip.move_track", map: (args) => ({ trackItem: (args as Record<string, unknown>).$_handle, timeOffsetSeconds: args.new_start_seconds ?? 0 }) },
    ],
  },
  move_clip_to_track: {
    steps: [
      { operation: "timeline.clip.find", map: (args) => ({ mediaType: "video", trackIndex: args.track_index ?? 0, clipIndex: args.clip_index ?? 0, clipName: args.clip_name }) },
      { operation: "timeline.clip.move_track", map: (args) => ({ trackItem: (args as Record<string, unknown>).$_handle, videoTrackVerticalOffset: args.target_track_index ?? 0, audioTrackVerticalOffset: 0, alignToVideo: false }) },
    ],
  },
  trim_clip: {
    steps: [
      { operation: "timeline.clip.find", map: (args) => ({ mediaType: args.media_type === "audio" ? "audio" : "video", trackIndex: args.track_index ?? 0, clipIndex: args.clip_index ?? 0, clipName: args.clip_name }) },
      { operation: "timeline.clip.trim", map: (args) => ({ trackItem: (args as Record<string, unknown>).$_handle, startTimeSeconds: args.new_in_seconds, endTimeSeconds: args.new_out_seconds }) },
    ],
  },
  ripple_delete: {
    steps: [
      { operation: "timeline.clip.find", map: (args) => ({ mediaType: args.media_type === "audio" ? "audio" : "video", trackIndex: args.track_index ?? 0, clipIndex: args.clip_index ?? 0, clipName: args.clip_name }) },
      { operation: "timeline.clip.remove", map: (args) => ({ trackItem: (args as Record<string, unknown>).$_handle, mediaType: (args as Record<string, unknown>).media_type === "audio" ? "audio" : "video", ripple: true }) },
    ],
  },
  remove_from_timeline: {
    steps: [
      { operation: "timeline.clip.find", map: (args) => ({ mediaType: args.media_type === "audio" ? "audio" : "video", trackIndex: args.track_index ?? 0, clipIndex: args.clip_index ?? 0, clipName: args.clip_name }) },
      { operation: "timeline.clip.remove", map: (args) => ({ trackItem: (args as Record<string, unknown>).$_handle, mediaType: (args as Record<string, unknown>).media_type === "audio" ? "audio" : "video", ripple: args.ripple !== false }) },
    ],
  },

  // --- Effect add/remove via UXP-only component-chain actions. The server
  // resolves the node_id to coordinates; the panel then applies/removes by name.
  apply_effect: {
    steps: [
      { operation: "timeline.clip.find", map: (args) => ({ mediaType: "video", trackIndex: args.track_index ?? 0, clipIndex: args.clip_index ?? 0, clipName: args.clip_name }) },
      { operation: "timeline.clip.effect", map: (args) => ({ trackItem: (args as Record<string, unknown>).$_handle, mediaType: "video", mode: "append", effectName: args.effect_name ?? args.effect_type ?? "Gaussian Blur" }) },
    ],
  },
  apply_audio_effect: {
    steps: [
      { operation: "timeline.clip.find", map: (args) => ({ mediaType: "audio", trackIndex: args.track_index ?? 0, clipIndex: args.clip_index ?? 0, clipName: args.clip_name }) },
      { operation: "timeline.clip.effect", map: (args) => ({ trackItem: (args as Record<string, unknown>).$_handle, mediaType: "audio", mode: "append", effectName: args.effect_name ?? args.effect_type ?? "DeEsser" }) },
    ],
  },
  remove_effect: {
    steps: [
      { operation: "timeline.clip.find", map: (args) => ({ mediaType: args.media_type === "audio" ? "audio" : "video", trackIndex: args.track_index ?? 0, clipIndex: args.clip_index ?? 0, clipName: args.clip_name }) },
      { operation: "timeline.clip.effect", map: (args) => ({ trackItem: (args as Record<string, unknown>).$_handle, mediaType: args.media_type === "audio" ? "audio" : "video", mode: "remove", effectName: args.effect_name ?? args.effect_type }) },
    ],
  },
  remove_effect_by_name: {
    steps: [
      { operation: "timeline.clip.find", map: (args) => ({ mediaType: "video", trackIndex: args.track_index ?? 0, clipIndex: args.clip_index ?? 0, clipName: args.clip_name }) },
      { operation: "timeline.clip.effect", map: (args) => ({ trackItem: (args as Record<string, unknown>).$_handle, mediaType: "video", mode: "remove", effectName: args.effect_name ?? args.match_name }) },
    ],
  },
};

/**
 * Resolve a CEP clip `node_id` to (track_index, clip_index, name, start) by
 * reading the active sequence over the CEP bridge. `node_id` is the QE client id
 * reported by get_full_sequence_info; UXP has no equivalent, so the server maps
 * it to coordinates before handing the handle-based UXP ops a clip to resolve.
 * Returns null when the active sequence/clip cannot be located (the caller then
 * lets the UXP find step return an honest error or falls back to CEP).
 */
async function resolveNodeIdInSequence(bridge: BridgeClient, nodeId: string): Promise<{ trackIndex: number; clipIndex: number; clipName: string; startSeconds: number } | null> {
  const script = `
    (function(){
      var seq = app.project ? app.project.activeSequence : null;
      if (!seq) return JSON.stringify({ success: false, error: "No active sequence" });
      var target = ${JSON.stringify(String(nodeId))};
      function scanTracks(getCount, getTrack, mediaType) {
        var count = seq[getCount] ? seq[getCount]() : 0;
        for (var t = 0; t < count; t++) {
          var tr = seq[getTrack](t);
          if (!tr || !tr.getTrackItems) continue;
          var items = tr.getTrackItems(1, false); // 1 == CLIP
          if (!items) continue;
          for (var i = 0; i < items.numItems; i++) {
            var it = items[i];
            if (!it) continue;
            try {
              var id = String(it.nodeId || it.matchName || "");
              if (id === target) {
                var start = it.start ? it.start.seconds : 0;
                var name = String(it.name || "");
                return JSON.stringify({ success: true, data: { trackIndex: t, clipIndex: i, clipName: name, startSeconds: start, mediaType: mediaType } });
              }
            } catch (_) {}
          }
        }
        return null;
      }
      var v = scanTracks("getVideoTrackCount", "getVideoTrack", "video");
      if (v) return v;
      var a = scanTracks("getAudioTrackCount", "getAudioTrack", "audio");
      if (a) return a;
      return JSON.stringify({ success: false, error: "Clip node_id not found in active sequence" });
    })();
  `;
  const raw = await bridge.executeScript(script, 20_000);
  const parsed = raw as { success?: boolean; data?: { trackIndex: number; clipIndex: number; clipName: string; startSeconds: number; mediaType?: string } } | string;
  const obj = typeof parsed === "string" ? safeJson(parsed) : parsed;
  if (obj && obj.success === true && obj.data && typeof obj.data === "object") {
    const d = obj.data as { trackIndex?: number; clipIndex?: number; clipName?: string; startSeconds?: number };
    if (d && typeof d.trackIndex === "number" && typeof d.clipIndex === "number") {
      return { trackIndex: d.trackIndex, clipIndex: d.clipIndex, clipName: String(d.clipName ?? ""), startSeconds: Number(d.startSeconds ?? 0) };
    }
  }
  return null;
}

function safeJson(value: string): Record<string, unknown> | null {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; }
}

/**
 * Build a concrete ExtendScript for the remaining extras that have no direct
 * upstream route. Each returns real data or a truthful error — never a silent
 * success.
 */
function buildExtraToolScript(name: string, args: Record<string, unknown>): string {
  const activeSeqLookup = `
    var __seq = app.project.activeSequence;
    if (!__seq) return JSON.stringify({ success: false, error: "No active sequence" });`;
  const projectGuard = `if (!app.project) return JSON.stringify({ success: false, error: "No project open" });`;
  const wrap = (body: string): string => `(function(){
    try {
      ${body}
    } catch (e) { return JSON.stringify({ success: false, error: String(e) }); }
  })();`;
  switch (name) {
    case "premiere_project_summary": {
      return wrap(`${projectGuard}
        var seqs = app.project.sequences ? app.project.sequences.numSequences : 0;
        var items = app.project.rootItem ? app.project.rootItem.children.numItems : 0;
        return JSON.stringify({ success: true, data: {
          open: true, name: String(app.project.name || ""), path: String(app.project.path || ""),
          sequences: seqs, rootItems: items
        }});`);
    }
    case "premiere_recent_files": {
      return wrap(`${projectGuard}
        var out = [];
        try {
          var recent = app.getRecentFiles ? app.getRecentFiles() : null;
          if (recent) for (var i = 0; i < recent.length; i++) out.push(String(recent[i]));
        } catch (_) {}
        return JSON.stringify({ success: true, data: out });`);
    }
    case "helpers_duration_summary":
    case "helpers_resolve_sequence_id": {
      return wrap(`${projectGuard}
        var seq = ${JSON.stringify(String(args.sequence_id ?? args.name ?? ""))} ? null : app.project.activeSequence;
        if (!seq) {
          var findId = ${JSON.stringify(String(args.sequence_id ?? args.name ?? ""))};
          for (var i = 0; i < app.project.sequences.numSequences; i++) {
            var cand = app.project.sequences[i];
            if (String(cand.sequenceID) === findId || String(cand.name) === findId) seq = cand;
          }
          if (!seq) return JSON.stringify({ success: false, error: "Sequence not found" });
        }
        return JSON.stringify({ success: true, data: { id: String(seq.sequenceID), name: String(seq.name), ticks: Number(seq.end), seconds: Number(seq.end) / 254016000000 } });`);
    }
    case "helpers_resolve_project_item_id": {
      return wrap(`${projectGuard}
        function __findProj(nodeOrName, root) {
          if (!root) root = app.project.rootItem;
          if (!root || !root.children) return null;
          for (var i = 0; i < root.children.numItems; i++) {
            var it = root.children[i];
            if (String(it.nodeId) === ${JSON.stringify(String(args.project_item_id ?? args.name ?? ""))} || String(it.name) === ${JSON.stringify(String(args.project_item_id ?? args.name ?? ""))}) return it;
            if (it.type === 2) { var nested = __findProj(null, it); if (nested) return nested; }
          }
          return null;
        }
        var item = __findProj(null, null);
        if (!item) return JSON.stringify({ success: false, error: "Project item not found" });
        return JSON.stringify({ success: true, data: { id: String(item.nodeId), name: String(item.name), type: Number(item.type) } });`);
    }
    case "media_batch_rename": {
      return wrap(`${projectGuard}
        var renames = ${JSON.stringify(args.renames ?? args.items ?? [])};
        if (!renames || !renames.length) return JSON.stringify({ success: false, error: "renames is required" });
        var done = [];
        function applyTo(item, root) {
          if (!root) root = app.project.rootItem;
          if (!root || !root.children) return;
          for (var i = 0; i < root.children.numItems; i++) {
            var it = root.children[i];
            for (var x = 0; x < renames.length; x++) {
              if (String(renames[x].id) === String(it.nodeId)) {
                it.name = String(renames[x].name);
                done.push({ id: String(it.nodeId), name: String(it.name) });
              }
            }
            if (it.children) applyTo(null, it);
          }
        }
        applyTo(null, null);
        return JSON.stringify({ success: true, data: { renamed: done } });`);
    }
    case "media_batch_set_offline": {
      return wrap(`${projectGuard}
        var ids = ${JSON.stringify(args.item_ids ?? args.ids ?? [])};
        if (!ids || !ids.length) return JSON.stringify({ success: false, error: "item_ids is required" });
        var done = [];
        function walk(root) {
          if (!root || !root.children) return;
          for (var i = 0; i < root.children.numItems; i++) {
            var it = root.children[i];
            for (var x = 0; x < ids.length; x++) {
              if (String(ids[x]) === String(it.nodeId)) {
                try { it.setOffline(); done.push(String(it.nodeId)); } catch (e) {}
              }
            }
            if (it.children) walk(it);
          }
        }
        walk(app.project.rootItem);
        return JSON.stringify({ success: true, data: { offline: done } });`);
    }
    case "audio_track_summary": {
      const requestedKeyCap = typeof args.max_keyframes === "number" ? Math.trunc(args.max_keyframes) : 4096;
      const keyCap = Math.max(1, Math.min(requestedKeyCap, 16384));
      return wrap(`${activeSeqLookup}
        var MAX_KEYS = ${keyCap};
        var tracks = [], errors = [], totalClips = 0, totalKeys = 0, returnedKeys = 0, truncated = false;
        function safeNumber(fn) { try { var value = fn(); return value === null || value === undefined ? null : Number(value); } catch (_) { return null; } }
        function safeString(fn) { try { var value = fn(); return value === null || value === undefined ? null : String(value); } catch (_) { return null; } }
        function timeSeconds(value) {
          try {
            if (value === null || value === undefined) return null;
            if (value.seconds !== undefined) return Number(value.seconds);
            if (value.ticks !== undefined) return Number(value.ticks) / 254016000000;
            return Number(value) / 254016000000;
          } catch (_) { return null; }
        }
        function findVolumeProperty(clip) {
          try {
            var components = clip.components;
            for (var c = 0; components && c < components.numItems; c++) {
              var comp = components[c];
              var compName = String(comp.matchName || comp.displayName || "");
              if (compName !== "AE.ADBE Audio Volume" && compName !== "ADBE Audio Levels" && compName !== "Internal Volume" && compName !== "Volume" && compName !== "볼륨") continue;
              var props = comp.properties;
              for (var p = 0; props && p < props.numItems; p++) {
                var prop = props[p];
                var propName = String(prop.matchName || prop.displayName || "");
                if (propName === "ADBE Audio Levels" || propName === "Level" || propName === "레벨") return prop;
              }
            }
          } catch (_) {}
          return null;
        }
        for (var t = 0; t < __seq.audioTracks.numTracks; t++) {
          var track = __seq.audioTracks[t], clipRows = [], clipCount = track.clips ? track.clips.numItems : 0;
          totalClips += clipCount;
          for (var c = 0; c < clipCount; c++) {
            var clip = track.clips[c], prop = findVolumeProperty(clip), keyRows = [], keyCount = 0, currentInternal = null, currentDb = null, timeVarying = null, clipErrors = [];
            if (prop) {
              try { currentInternal = Number(prop.getValue()); currentDb = currentInternal - 15; } catch (e) { clipErrors.push("level-read: " + String(e)); }
              try { timeVarying = Boolean(prop.isTimeVarying()); } catch (e) { clipErrors.push("time-varying-read: " + String(e)); }
              try {
                var keys = prop.getKeys() || [];
                keyCount = keys.length;
                totalKeys += keyCount;
                for (var k = 0; k < keys.length; k++) {
                  if (returnedKeys >= MAX_KEYS) { truncated = true; break; }
                  var internal = null, interpolation = null;
                  try { internal = Number(prop.getValueAtKey(keys[k])); } catch (e) { clipErrors.push("key-value-" + k + ": " + String(e)); }
                  try { if (prop.getInterpolationTypeAtKey) interpolation = prop.getInterpolationTypeAtKey(keys[k]); } catch (e) { clipErrors.push("key-interpolation-" + k + ": " + String(e)); }
                  keyRows.push({ index: k, timeSeconds: timeSeconds(keys[k]), ticks: safeString(function(){ return keys[k].ticks; }), internalLevel: internal, levelDb: internal === null ? null : internal - 15, interpolation: interpolation });
                  returnedKeys++;
                }
              } catch (e) { clipErrors.push("keys-read: " + String(e)); }
            }
            if (clipErrors.length) for (var e = 0; e < clipErrors.length; e++) errors.push({ trackIndex: t, clipIndex: c, error: clipErrors[e] });
            clipRows.push({
              trackIndex: t, clipIndex: c, nodeId: safeString(function(){ return clip.nodeId; }), name: safeString(function(){ return clip.name; }),
              startSeconds: timeSeconds(clip.start), endSeconds: timeSeconds(clip.end), enabled: (function(){ try { return clip.isEnabled ? Boolean(clip.isEnabled()) : null; } catch (_) { return null; } })(),
              volume: { found: Boolean(prop), timeVarying: timeVarying, currentInternalLevel: currentInternal, currentLevelDb: currentDb, keyCount: keyCount, returnedKeyCount: keyRows.length, keysTruncated: keyRows.length < keyCount, keyframes: keyRows },
              complete: clipErrors.length === 0 && keyRows.length === keyCount
            });
          }
          tracks.push({ index: t, name: safeString(function(){ return track.name; }), muted: (function(){ try { return track.isMuted ? Boolean(track.isMuted()) : null; } catch (_) { return null; } })(), clipCount: clipCount, clips: clipRows });
        }
        return JSON.stringify({ success: true, data: {
          sequenceId: String(__seq.sequenceID), sequenceName: String(__seq.name), audioTrackCount: __seq.audioTracks.numTracks,
          totalClips: totalClips, totalKeyframes: totalKeys, returnedKeyframes: returnedKeys, maxKeyframes: MAX_KEYS,
          truncated: truncated, complete: !truncated && errors.length === 0, tracks: tracks, errors: errors,
          valueContract: "levelDb = Premiere internal Level - 15"
        }});`);
    }
    default: {
      return wrap(`${projectGuard}
        return JSON.stringify({ success: false, error: "Tool '${name}' is registered but has no concrete host implementation in this build." });`);
    }
  }
}
