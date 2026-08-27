import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getUpstreamToolModules } from "../vendor/upstream/tools/catalog.js";
import { EXTRA_TOOL_NAMES } from "./tool-names.js";

/**
 * Transport that upstream tool handlers talk to.
 *
 * Upstream tools call `transport.executeScript(script)` and expect a
 * normalized `{ success, data } | { success: false, error }` object back.
 * Our bridge implements the `executeScript` side by relaying the full
 * ExtendScript to the CEP host through the always-on daemon.
 */
export interface ScriptTransport {
  executeScript(script: string, timeoutMs?: number): Promise<unknown>;
}

/** Result shape the upsteam handlers produce and consume. */
export interface UpstreamResult {
  success: boolean;
  data?: unknown;
  error?: string;
  result?: unknown;
}

/** What the MCP server needs from the bridge: execute scripts, report status. */
export interface BridgeClient extends ScriptTransport {
  get connected(): boolean;
  get port(): number;
  uxp(operation: string, args?: Record<string, unknown>, expectedRevision?: string): Promise<unknown>;
}

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
      return { success: false, error: String(rec.error ?? "Unknown error") };
    }
    if (rec.success === true) return rec.data ?? rec.result ?? {};
  }
  return raw;
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
  const server = new McpServer({ name: "premiere-pro-full-mcp", version: "1.1.0" });

  const upstream = getUpstreamToolModules(bridge);

  server.registerTool("premiere_capabilities", {
    title: "Bridge capabilities",
    description: "Return the connected host version and tool counts.",
    inputSchema: {
      domain: z.enum(["project", "sequence", "timeline", "media", "effects", "captions", "export", "playback", "workspace", "helpers"]).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    let uxp = { connected: false, hostVersion: null, capabilities: [] as string[] };
    try {
      const probe = (await bridge.uxp("uxp.catalog", { query: "", limit: 1 })) as { counts?: unknown } | null;
      uxp = { connected: true, hostVersion: null, capabilities: [] };
      void probe;
    } catch {
      uxp = { connected: false, hostVersion: null, capabilities: [] };
    }
    return textResult({
      connected: bridge.connected,
      uxpConnected: uxp.connected,
      toolCount: Object.keys(upstream).length,
      extraCount: EXTRA_TOOL_NAMES.length,
      total: Object.keys(upstream).length + EXTRA_TOOL_NAMES.length + 1,
    });
  });

  for (const [name, tool] of Object.entries(upstream)) {
    const params = (tool.parameters ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
    const schema = zodFromParameters(params);
    server.registerTool(`premiere_${name}`, {
      title: name,
      description: tool.description ?? `Premiere Pro: ${name}`,
      inputSchema: schema,
      annotations: {
        readOnlyHint: name.startsWith("get_") || name.startsWith("list_") || name.startsWith("helpers_") || name === "get_project_info" || name === "get_active_sequence" || name === "get_playhead_position",
        destructiveHint: /^(delete_|set_|rename_|move_|import_|export_|remove_|reset_|trim_|split_|razor|overwrite|replace_|undo|redo|add_|duplicate_|nest_|freeze|extract|lift_)/.test(name),
        openWorldHint: false,
      },
    }, async (args) => {
      // UXP second track pre-dispatch: some official tool names have a
      // truthful UXP-only implementation (export.frame, capture_frame). If the
      // UXP panel is connected, route there first; otherwise fall through to
      // the upstream ExtendScript handler (which reports the honest error or,
      // for UXP-only operations, the real unsupported reason).
      if (UXP_ROUTES[name]) {
        const uxpResult = await dispatchUxp(bridge, name, args ?? {});
        if (uxpResult !== UXP_FALLTHROUGH) return textResult(uxpResult);
      }
      const result = await tool.handler(args ?? {});
      return textResult(normalizeUpstream(result));
    });
  }

  for (const name of EXTRA_TOOL_NAMES) {
    server.registerTool(`premiere_${name}`, {
      title: name,
      description: buildExtraDescription(name),
      inputSchema: argsSchemaFor(name),
      annotations: {
        readOnlyHint: name.startsWith("get_") || name.startsWith("list_") || name.startsWith("helpers_") || name.includes("_report") || name.includes("_summary") || name.includes("_inventory") || name.includes("_status") || name.includes("_snapshot") || name.includes("_count"),
        destructiveHint: /^(delete_|set_|rename_|move_|import_|export_|remove_|reset_|trim_|split_|razor|overwrite|replace_|undo|redo|add_|duplicate_|nest_|freeze|extract|lift_)/.test(name),
        openWorldHint: false,
      },
    }, async (args) => {
      const result = await executeExtraTool(bridge, upstream, name, args ?? {});
      return textResult(result);
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

function buildExtraDescription(name: string): string {
  const prefix = name.includes("_") ? name.split("_")[0]! : name;
  return `Premiere Pro: ${name}. Local-first operation over the always-on bridge. Domain: ${prefix}.`;
}

/** Minimal per-tool arg shapes for the extra tools. */
function argsSchemaFor(name: string): Record<string, z.ZodType> {
  const idField = z.string().min(1).max(512);
  const common: Record<string, z.ZodType> = {};
  if (/_sequence/.test(name) || name.startsWith("sequence_") || name.startsWith("timeline_")) common.sequence_id = idField.optional();
  if (/_project_item|project_item|_item/.test(name) || name.startsWith("media_") || name.startsWith("project_")) common.project_item_id = idField.optional();
  if (name.startsWith("media_") || name.includes("import")) common.paths = z.array(z.string().min(1).max(4096)).max(128).optional();
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
    })();`, 300_000);
    return normalizeUpstream(result);
  }
  if (name === "helpers_resolve_sequence_id" || name === "helpers_resolve_project_item_id") {
    const result = await bridge.executeScript(buildExtraToolScript(name, args), 300_000);
    return normalizeUpstream(result);
  }
  if (name === "premiere_connection_status" || name === "premiere_health_check") return { connected: bridge.connected, port: bridge.port };

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
  return normalizeUpstream(await bridge.executeScript(buildExtraToolScript(name, args), 300_000));
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
  media_batch_relink: { target: "relink_media" },
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

  audio_track_summary: { target: "list_sequence_tracks" },

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
 * Dispatch a named tool through the UXP bridge path. Returns a normalized
 * { success, data|error } result. If the UXP panel is not connected or this
 * operation is not in the route map, returns UXP_FALLTHROUGH so the caller can
 * fall back to the upstream ExtendScript handler (which produces an honest
 * "not supported by this bridge" error rather than a fake success).
 */
async function dispatchUxp(bridge: BridgeClient, name: string, args: Record<string, unknown>): Promise<unknown | typeof UXP_FALLTHROUGH> {
  const route = UXP_ROUTES[name];
  if (!route) return UXP_FALLTHROUGH;
  const uxpResult = (await bridge.uxp(route.operation, route.map ? route.map(args) : args)) as { success?: boolean; data?: unknown; error?: string; code?: string };
  if (uxpResult?.success === false) {
    // If the panel is simply not connected, let the upstream handler run so it
    // can return the documented CEP-only unsupported error.
    if (uxpResult.code === "UXP_UNAVAILABLE" || uxpResult.code === "UXP_NOT_CONNECTED") return UXP_FALLTHROUGH;
    return { success: false, error: String(uxpResult.error ?? "UXP operation failed"), code: String(uxpResult.code ?? "UXP_FAILED") };
  }
  return uxpResult?.data ?? {};
}

/**
 * UXP second track: tools whose only truthful implementation lives on the
 * Premiere UXP panel bridge. Each entry maps the flat MCP tool name to a UXP
 * operation. These operations need UXP APIs that CEP/ExtendScript cannot
 * reach, so we route them through bridge.uxp() when the panel is connected.
 */
export const UXP_ROUTES: Record<string, { operation: string; map?: (args: Record<string, unknown>) => Record<string, unknown> }> = {
  // Frame / sequence export via Exporter (CEP lacks exportFramePNG).
  capture_frame: { operation: "export.frame", map: (args) => ({ outputPath: String(args.output_path ?? ""), timeSeconds: args.time_seconds, format: args.format }) },
  export_frame: { operation: "export.frame", map: (args) => ({ outputPath: String(args.output_path ?? ""), timeSeconds: args.time_seconds, format: args.format }) },
};

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
    default: {
      return wrap(`${projectGuard}
        return JSON.stringify({ success: false, error: "Tool '${name}' is registered but has no concrete host implementation in this build." });`);
    }
  }
}
