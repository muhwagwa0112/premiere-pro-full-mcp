import { ALL_TOOL_NAMES, type ExtraToolName, type OfficialToolName } from "../tool-names.js";
import type { OperationMode } from "./types.js";

export type KnownToolName = OfficialToolName | ExtraToolName;
export type CheckpointRequirement = "none" | "before" | "before-and-after" | "save-boundary";

export interface ToolPolicy {
  mode: OperationMode;
  maxScriptBytes: number;
  maxTransportScriptBytes: number;
  maxArgsBytes: number;
  maxItems: number;
  maxExecutionTimeoutMs: number;
  maxQueueDeadlineMs: number;
  checkpoint: CheckpointRequirement;
  highRisk: boolean;
}

const LOCAL_TOOLS = new Set<KnownToolName>([
  "helpers_ticks_to_timecode",
  "helpers_timecode_to_ticks",
  "helpers_seconds_to_timecode",
  "helpers_timecode_to_seconds",
  "premiere_connection_status",
  "premiere_health_check",
]);

const READ_TOOLS = new Set<KnownToolName>([
  "check_offline_media", "evaluate_expression", "find_items_by_media_path", "find_project_item_by_name",
  "get_active_sequence", "get_all_project_paths", "get_bin_contents", "get_clip_adjustment_layer",
  "get_clip_at_playhead", "get_clip_at_position", "get_clip_links", "get_clip_markers", "get_clip_properties",
  "get_clip_speed", "get_color_label", "get_color_space", "get_duplicate_media", "get_effect_properties",
  "get_encoder_presets", "get_export_file_extension", "get_footage_interpretation", "get_full_clip_info",
  "get_full_project_overview", "get_full_sequence_info", "get_graphics_white_luminance", "get_insertion_bin",
  "get_item_info", "get_keyframes", "get_linked_items", "get_metadata", "get_mogrt_component",
  "get_next_edit_point", "get_offline_media", "get_playhead_position", "get_premiere_state", "get_project_info",
  "get_project_item_info", "get_project_panel_metadata", "get_project_scratch_disks", "get_qe_clip_info",
  "get_render_queue_status", "get_selected_clips", "get_sequence_count", "get_sequence_in_out_points",
  "get_sequence_markers_by_type", "get_sequence_settings", "get_sequence_structure", "get_source_monitor_info",
  "get_source_monitor_position", "get_target_tracks", "get_timeline_gaps", "get_timeline_summary",
  "get_total_clip_count", "get_track_info", "get_unused_media", "get_used_media_report", "get_value_at_time",
  "get_version_info", "get_work_area", "get_workspaces", "get_xmp_metadata", "has_proxy", "inspect_dom_object",
  "is_work_area_enabled", "list_available_audio_effects", "list_available_audio_transitions", "list_available_effects",
  "list_available_transitions", "list_clip_effects", "list_markers", "list_project_items", "list_sequence_tracks",
  "list_sequences", "ping", "search_project_items",
  "timeline_list_all_clips", "timeline_gap_report", "timeline_track_summary", "timeline_clip_count",
  "timeline_summary_ratios", "media_list_all_items", "media_unused_media_report", "media_duplicate_media_report",
  "media_metadata_bulk_read", "project_structure_tree", "project_bin_recursive_contents", "project_autosave_status",
  "captions_export_srt", "captions_cue_count", "captions_cue_snapshot", "text_mogrt_inventory", "text_style_snapshot",
  "text_font_inventory", "audio_track_summary", "effects_chain_inventory", "transitions_inventory",
  "export_preset_finder", "export_render_queue_status", "premiere_project_summary", "premiere_recent_files",
  "helpers_duration_summary", "helpers_resolve_sequence_id", "helpers_resolve_project_item_id", "transcript_export_srt",
]);

const SAVE_TOOLS = new Set<KnownToolName>(["save_project", "save_project_as", "export_as_project"]);
const BATCH_PATTERN = /(?:^batch_|_batch_|_all_|multiple_|consolidate|transfer|render_queue)/;

const READ_POLICY: ToolPolicy = Object.freeze({
  mode: "read", maxScriptBytes: 128 * 1024, maxTransportScriptBytes: 256 * 1024, maxArgsBytes: 128 * 1024, maxItems: 512,
  maxExecutionTimeoutMs: 30_000, maxQueueDeadlineMs: 30_000, checkpoint: "none", highRisk: false,
});
const MUTATE_POLICY: ToolPolicy = Object.freeze({
  mode: "mutate", maxScriptBytes: 64 * 1024, maxTransportScriptBytes: 128 * 1024, maxArgsBytes: 64 * 1024, maxItems: 64,
  maxExecutionTimeoutMs: 60_000, maxQueueDeadlineMs: 30_000, checkpoint: "before-and-after", highRisk: false,
});
const LOCAL_POLICY: ToolPolicy = Object.freeze({
  mode: "local", maxScriptBytes: 0, maxTransportScriptBytes: 0, maxArgsBytes: 32 * 1024, maxItems: 512,
  maxExecutionTimeoutMs: 5_000, maxQueueDeadlineMs: 5_000, checkpoint: "none", highRisk: false,
});

function policyForKnown(name: KnownToolName): ToolPolicy {
  if (name === "execute_extendscript") {
    return Object.freeze({ ...MUTATE_POLICY, maxScriptBytes: 16 * 1024, maxTransportScriptBytes: 64 * 1024, maxArgsBytes: 32 * 1024, maxItems: 1, maxExecutionTimeoutMs: 120_000, checkpoint: "before-and-after", highRisk: true });
  }
  if (name === "import_fcp_xml") {
    return Object.freeze({ ...MUTATE_POLICY, maxExecutionTimeoutMs: 300_000, maxQueueDeadlineMs: 120_000, maxItems: 1, highRisk: true });
  }
  if (name === "export_frame" || name === "capture_frame") {
    return Object.freeze({ ...MUTATE_POLICY, maxExecutionTimeoutMs: 120_000, maxQueueDeadlineMs: 120_000, maxItems: 1 });
  }
  if (LOCAL_TOOLS.has(name)) return LOCAL_POLICY;
  if (READ_TOOLS.has(name)) return READ_POLICY;
  if (SAVE_TOOLS.has(name)) return Object.freeze({ ...MUTATE_POLICY, checkpoint: "save-boundary", maxItems: 1 });
  if (BATCH_PATTERN.test(name)) return Object.freeze({ ...MUTATE_POLICY, maxItems: 32, maxExecutionTimeoutMs: 45_000 });
  return MUTATE_POLICY;
}

/** Every current catalog name receives a policy; unknown future names fail closed. */
export const TOOL_POLICIES: Readonly<Record<KnownToolName, ToolPolicy>> = Object.freeze(
  Object.fromEntries(ALL_TOOL_NAMES.map((name) => [name, policyForKnown(name)])) as Record<KnownToolName, ToolPolicy>,
);

export function getToolPolicy(toolName: string): ToolPolicy {
  const normalized = Object.prototype.hasOwnProperty.call(TOOL_POLICIES, toolName)
    ? toolName
    : toolName.startsWith("premiere_") ? toolName.slice("premiere_".length) : toolName;
  if (!Object.prototype.hasOwnProperty.call(TOOL_POLICIES, normalized)) {
    throw new Error(`No operation-safety policy exists for tool '${toolName}'`);
  }
  return TOOL_POLICIES[normalized as KnownToolName];
}

export interface PolicyInput {
  script?: string;
  scriptBytes: number;
  argsBytes: number;
  itemCount: number;
  executionTimeoutMs: number;
  queueDeadlineMs: number;
  estimatedRiskyCalls?: number;
}

export class ToolPolicyError extends Error {
  readonly code = "TOOL_POLICY_REJECTED";
  readonly field: string;
  readonly observed: number | string;
  readonly limit: number | string;
  constructor(toolName: string, field: string, observed: number | string, limit: number | string) {
    super(`${toolName} ${field} '${observed}' exceeds policy limit '${limit}'`);
    this.name = "ToolPolicyError";
    this.field = field;
    this.observed = observed;
    this.limit = limit;
  }
}

function assertRawOperationClasses(toolName: string, script: string, maximum: number, estimatedRiskyCalls?: number): void {
  const placementCalls = (script.match(/\b(?:overwriteClip|insertClip|insertFromSource|overwriteFromSource|addToTimeline)\s*\(/g) ?? []).length;
  const keyframeCalls = (script.match(/\b(?:addKey|setValueAtKey|setValueAtTime|setTemporalEaseAtKey|setInterpolationTypeAtKey)\s*\(/g) ?? []).length;
  const saveCalls = (script.match(/\b(?:app\.project\.)?(?:save|saveAs)\s*\(/g) ?? []).length;
  const mutationCalls = (script.match(/\b(?:overwriteClip|insertClip|insertFromSource|overwriteFromSource|addToTimeline|addKey|setValueAtKey|setValueAtTime|setTemporalEaseAtKey|setInterpolationTypeAtKey|remove|delete|setValue)\s*\(/g) ?? []).length;
  if (placementCalls > 0 && keyframeCalls > 0) throw new ToolPolicyError(toolName, "mixed operation classes", "placement+keyframe", "one class per call");
  if (saveCalls > 0 && mutationCalls > 0) throw new ToolPolicyError(toolName, "mixed operation classes", "mutation+save", "one class per call");
  // A single keyframe transaction is one bounded operation even though it has
  // several necessary calls (add, value, interpolation).  Placement and save
  // remain mutually exclusive operation classes.
  const keyframeOnly = placementCalls === 0 && saveCalls === 0 && keyframeCalls > 0 && mutationCalls === keyframeCalls;
  const estimated = estimatedRiskyCalls ?? (keyframeOnly ? 1 : saveCalls + mutationCalls);
  if (estimated > maximum) throw new ToolPolicyError(toolName, "estimated risky calls", estimated, maximum);
}

/**
 * Conservative validator for an explicitly requested raw read-only script.
 * It is intentionally opt-in: callers must supply an explicit read-only mode,
 * and a script containing any known mutation, persistence, import/export, or
 * dynamic-evaluation primitive is rejected.  It does not silently reclassify
 * arbitrary scripts; hosts must still execute it under a read-only operation.
 */
export function assertRawExtendScriptReadOnly(toolName: string, script: string): void {
  const directForbidden = /\b(?:overwriteClip|insertClip|insertFromSource|overwriteFromSource|addToTimeline|addKey|setValueAtKey|setValueAtTime|setTemporalEaseAtKey|setInterpolationTypeAtKey|setValue|remove|delete|save|saveAs|importFiles|export|createNewSequence|eval|executeCommand|Function)\s*\(/i;
  const mutatingMember = /\.(?:set|add|remove|delete|save|close|open|create|import|export|execute|enable)[A-Za-z0-9_]*\s*\(/i;
  // Local variables and fixed loops are permitted.  Bracket member access is
  // rejected because it can hide an arbitrary host method from this static
  // policy boundary (for example `app.project[methodName]()` or `prop["setValue"]()`).
  const dynamicMember = /(?:\bapp\b|\bqe\b|\bsequence\b|\bproject\b|\bprop\b)\s*\[/i;
  const computedCall = /\[[^\]]+\]\s*\(/;
  const memberAssignment = /(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*(?:=|\+=|-=|\*=|\/=)(?!=)/;
  if (directForbidden.test(script) || mutatingMember.test(script) || dynamicMember.test(script) || computedCall.test(script) || memberAssignment.test(script) || /\+\+|--|\bdelete\b/.test(script)) {
    throw new ToolPolicyError(toolName, "read-only script contains a prohibited operation", "mutation-or-dynamic-call", "read-only subset");
  }
}

export function assertToolWithinPolicy(toolName: string, input: PolicyInput): ToolPolicy {
  const policy = getToolPolicy(toolName);
  const checks: Array<[number, number, string]> = [
    [input.scriptBytes, policy.maxScriptBytes, "script bytes"], [input.argsBytes, policy.maxArgsBytes, "argument bytes"],
    [input.itemCount, policy.maxItems, "item count"], [input.executionTimeoutMs, policy.maxExecutionTimeoutMs, "execution timeout"],
    [input.queueDeadlineMs, policy.maxQueueDeadlineMs, "queue deadline"],
  ];
  for (const [actual, maximum, label] of checks) {
    if (!Number.isFinite(actual) || actual < 0 || actual > maximum) {
      throw new ToolPolicyError(toolName, label, actual, maximum);
    }
  }
  const normalized = toolName === "execute_extendscript" || toolName === "premiere_execute_extendscript" ? "execute_extendscript" : toolName;
  if (normalized === "execute_extendscript") {
    const script = input.script ?? "";
    const utf8Bytes = Buffer.byteLength(script, "utf8");
    if (utf8Bytes !== input.scriptBytes) throw new ToolPolicyError(toolName, "declared script bytes", input.scriptBytes, utf8Bytes);
    assertRawOperationClasses(toolName, script, policy.maxItems, input.estimatedRiskyCalls);
  }
  return policy;
}

export function assertTransportWithinPolicy(toolName: string, input: PolicyInput): ToolPolicy {
  const policy = getToolPolicy(toolName);
  const checks: Array<[number, number, string]> = [
    [input.scriptBytes, policy.maxTransportScriptBytes, "transport script bytes"],
    [input.argsBytes, policy.maxArgsBytes, "argument bytes"],
    [input.itemCount, policy.maxItems, "item count"],
    [input.executionTimeoutMs, policy.maxExecutionTimeoutMs, "execution timeout"],
    [input.queueDeadlineMs, policy.maxQueueDeadlineMs, "queue deadline"],
  ];
  for (const [actual, maximum, label] of checks) {
    if (!Number.isFinite(actual) || actual < 0 || actual > maximum) throw new ToolPolicyError(toolName, label, actual, maximum);
  }
  // Generated execute_extendscript wrappers intentionally contain helper
  // methods whose names look mutating. The daemon independently validates the
  // caller source at begin_operation and requires byte-for-byte equality with
  // buildToolScript(source) here, so this transport gate is size/deadline only.
  return policy;
}
