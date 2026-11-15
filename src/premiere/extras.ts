import { z } from "zod";
import { readFile, writeFile, copyFile, mkdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { BridgeClient } from "../server.js";
import { parseSrt, serializeSrt, validateCues, type CaptionCue } from "./captions.js";
import { editAudio } from "./audio.js";
import { secondsToTicks } from "./time.js";
import { hashFile } from "../automation/assets.js";
import { EFFECT_BATCH_FIELDS } from "./effect-batch.js";

const id = z.string().trim().min(1).max(512), path = z.string().min(1).max(4096);
const tick = z.string().regex(/^-?\d+$/);
const locator = { node_id: id, sequence_id: id.optional(), media_type: z.enum(["video", "audio"]).optional() };
const cue = z.object({ id, startTicks: tick, endTicks: tick, text: z.string().min(1) }).strict();
const gain = z.object({ itemKey: id, ...locator, level_db: z.number().min(-96).max(24), encoding_profile_id: id.optional() }).strict();
const captionSource = { srt_path: path.optional(), cues: z.array(cue).max(10000).optional(), sequence_id: id.optional() };
export const SEMANTIC_EXTRA_SCHEMAS: Record<string, Record<string, z.ZodType>> = {
  timeline_clip_count: { sequence_id: id.optional() },
  media_batch_rename: { renames: z.array(z.object({ id, name: id }).strict()).min(1).max(64) },
  media_batch_set_offline: { item_ids: z.array(id).min(1).max(64) },
  project_close_inactive: { project_guid: id, expected_host_epoch: id, save_policy: z.enum(["save", "discard"]) },
  effects_batch_apply: EFFECT_BATCH_FIELDS,
  effects_batch_remove: EFFECT_BATCH_FIELDS,
  effects_chain_inventory: locator,
  effects_match_parameter: { ...locator, component_match_name: id, parameter_name: id },
  effects_keyframe_reset: { ...locator, component_match_name: id, component_index: z.number().int().nonnegative().optional(), parameter_index: z.number().int().nonnegative() },
  transitions_batch_add: { items: z.array(z.object({ itemKey: id, ...locator, transition_name: id, duration_seconds: z.number().positive() }).strict()).min(1).max(32) },
  audio_batch_clip_gain: { items: z.array(gain).min(1).max(32) },
  audio_duck_on_markers: { ...locator, base_db: z.number().min(-96).max(24), duck_db: z.number().min(-96).max(24),
    attack_seconds: z.number().min(0).default(0.1), release_seconds: z.number().min(0).default(0.3),
    ranges: z.array(z.object({ start_seconds: z.number().nonnegative(), end_seconds: z.number().positive() }).strict()).min(1).max(64) },
  captions_import_srt: { srt_path: path, sequence_id: id.optional(), start_seconds: z.number().nonnegative().default(0) },
  captions_export_srt: { ...captionSource, output_path: path },
  captions_cue_count: captionSource,
  captions_cue_snapshot: captionSource,
  transcript_export_srt: { cues: z.array(cue).min(1).max(10000), output_path: path },
  media_proxy_attach_all: { items: z.array(z.object({ itemKey: id, project_item_id: id, proxy_path: path }).strict()).min(1).max(32) },
  media_proxy_detach_all: { item_ids: z.array(id).min(1).max(32) },
  media_consolidate_to_folder: { items: z.array(z.object({ itemKey: id, source_path: path }).strict()).min(1).max(128), output_folder: path },
  media_batch_replace: { items: z.array(z.object({ itemKey: id, project_item_id: id, path }).strict()).min(1).max(32) },
  media_set_color_label_batch: { items: z.array(z.object({ itemKey: id, project_item_id: id, label: z.number().int().min(0).max(15) }).strict()).min(1).max(32) },
  sequence_duplicate_batch: { sequence_guids: z.array(id).min(1).max(32), project_guid: id.optional() },
  text_mogrt_apply_batch: { items: z.array(z.object({ itemKey: id, sequence_guid: id, path, ticks: tick, video_track_index: z.number().int().nonnegative(), audio_track_index: z.number().int().min(-1).default(-1) }).strict()).min(1).max(32) },
  text_style_snapshot: locator,
  export_render_queue_status: { export_job_id: id },
  export_all_sequences: { items: z.array(z.object({ itemKey: id, sequence_guid: id, output_path: path, preset_path: path }).strict()).min(1).max(32) },
  export_batch_ame: { items: z.array(z.object({ itemKey: id, sequence_guid: id, output_path: path, preset_path: path }).strict()).min(1).max(32) },
  export_sequence_custom_range: { sequence_guid: id, output_path: path, preset_path: path, in_ticks: tick, out_ticks: tick, export_job_id: id },
  playback_jump_to_next_edit: { sequence_id: id.optional() },
  playback_jump_to_prev_edit: { sequence_id: id.optional() },
  timeline_extend_edit_to_track_end: { ...locator, end_ticks: tick },
};
export const IMPLEMENTED_EXTRAS = new Set(Object.keys(SEMANTIC_EXTRA_SCHEMAS));
function unwrap(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return unwrap(JSON.parse(value));
  const r = value as Record<string, unknown>;
  if (r?.success === false) throw Object.assign(new Error(String(r.error ?? r.code)), r);
  if (r?.data !== undefined) return unwrap(r.data);
  if (r?.result !== undefined) return { ...(r.result as Record<string, unknown>), verification: r.verification };
  return r ?? {};
}
function batchFailure(error: unknown): Record<string, unknown> {
  const e = error as { message?: string; code?: string; outcomeUnknown?: boolean };
  return { success: false, code: e.code ?? "BATCH_ITEM_FAILED", error: e.message ?? String(error), outcomeUnknown: e.outcomeUnknown === true };
}
async function batch(items: Record<string, unknown>[], invoke: (item: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
  const keys = new Set<string>(), results: Record<string, unknown>[] = [];
  let stopped = false;
  for (const [index, item] of items.entries()) {
    const itemKey = String(item.itemKey ?? index);
    if (keys.has(itemKey)) throw new Error("Duplicate batch itemKey");
    keys.add(itemKey);
  }
  for (const [index, item] of items.entries()) {
    const itemKey = String(item.itemKey ?? index);
    if (stopped) { results.push({ itemKey, status: "NOT_ATTEMPTED" }); continue; }
    try {
      const value = await invoke(item);
      const result = unwrap(value);
      const metadata = result.uxpVerification as { verification?: { outcome?: string } } | undefined;
      const verification = (result.verification ?? metadata?.verification) as { outcome?: string } | undefined;
      if (verification?.outcome === "committed_unverified") throw Object.assign(new Error("Host applied the item without a verified postcondition"), { code: "APPLIED_UNVERIFIED", outcomeUnknown: true });
      results.push({ itemKey, status: "SUCCEEDED", result });
    } catch (error) { results.push({ itemKey, status: "FAILED", ...batchFailure(error) }); stopped = true; }
  }
  return { success: !stopped, requested: items.length, applied: results.filter(r => r.status === "SUCCEEDED").length,
    failed: results.filter(r => r.status === "FAILED").length, notAttempted: results.filter(r => r.status === "NOT_ATTEMPTED").length, results };
}
const wrap = (body: string) => "(function(){try{" + body + "}catch(e){return JSON.stringify({success:false,error:String(e)});}})();";
function sequenceScript(idValue: unknown): string {
  return "var seq=null,requested=" + JSON.stringify(String(idValue ?? "")) + ";if(!requested)seq=app.project.activeSequence;else for(var s=0;s<app.project.sequences.numSequences;s++)if(String(app.project.sequences[s].sequenceID)===requested){if(seq)throw Error('TARGET_NOT_UNIQUE');seq=app.project.sequences[s];}if(!seq)throw Error('TARGET_NOT_FOUND');";
}
const findItemScript = "function itemById(id,root){var found=[];function walk(x){if(!x.children)return;for(var i=0;i<x.children.numItems;i++){var c=x.children[i];if(String(c.nodeId)===id)found.push(c);if(c.children)walk(c);}}walk(root||app.project.rootItem);if(found.length!==1)throw Error('PROJECT_ITEM_NOT_UNIQUE');return found[0];}";
export async function executeSemanticExtra(bridge: BridgeClient, name: string, args: Record<string, unknown>, dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>): Promise<{ handled: boolean; value?: unknown }> {
  const done = (value: unknown) => ({ handled: true, value });
  if (!IMPLEMENTED_EXTRAS.has(name) || ["media_batch_rename", "media_batch_set_offline"].includes(name)) return { handled: false };
  if (name === "timeline_clip_count") return done(unwrap(await bridge.executeScript(wrap(sequenceScript(args.sequence_id) + "var video=0,audio=0;for(var v=0;v<seq.videoTracks.numTracks;v++)video+=seq.videoTracks[v].clips.numItems;for(var a=0;a<seq.audioTracks.numTracks;a++)audio+=seq.audioTracks[a].clips.numItems;return JSON.stringify({success:true,data:{sequenceId:String(seq.sequenceID),videoClips:video,audioClips:audio,total:video+audio}});"))));
  if (name === "project_close_inactive") {
    if (typeof args.expected_host_epoch !== "string" || !args.expected_host_epoch) throw Object.assign(new Error("Closing an inactive project requires its observed host epoch"), { code: "HOST_EPOCH_REQUIRED" });
    return done(unwrap(await bridge.uxp("pr.project.close_inactive", { projectGuid: args.project_guid, expectedHostEpoch: args.expected_host_epoch, savePolicy: args.save_policy })));
  }
  if (name === "effects_batch_apply" || name === "effects_batch_remove") {
    if (!bridge.workflowRequest) throw Object.assign(new Error("Durable effect batches require the updated daemon"), { code: "WORKFLOW_OWNER_UNAVAILABLE" });
    return done(await bridge.workflowRequest("legacyEffectBatch", { toolName: name, args }));
  }
  if (name === "transitions_batch_add") return done(await batch(args.items as Record<string, unknown>[], item => dispatch("add_transition_to_clip", item)));
  if (name === "audio_batch_clip_gain") return done(await batch(args.items as Record<string, unknown>[], item => editAudio(bridge, item, "scalar")));
  if (name === "audio_duck_on_markers") {
    const points = new Map<number, number>(), base = Number(args.base_db), duck = Number(args.duck_db);
    for (const r of args.ranges as { start_seconds: number; end_seconds: number }[]) {
      if (r.end_seconds <= r.start_seconds) throw new Error("Invalid duck range");
      points.set(Math.max(0, r.start_seconds - Number(args.attack_seconds)), base); points.set(r.start_seconds, duck);
      points.set(r.end_seconds, duck); points.set(r.end_seconds + Number(args.release_seconds), base);
    }
    return done(await editAudio(bridge, { ...args, keyframes: [...points].sort((a, b) => a[0] - b[0]).map(([time_seconds, level_db]) => ({ time_seconds, level_db })) }, "keyframes"));
  }
  if (["effects_chain_inventory", "text_style_snapshot", "effects_match_parameter", "effects_keyframe_reset"].includes(name)) {
    const found = unwrap(await dispatch("_find_exact_clip", args));
    const nativeArgs = { trackItem: found.handle, mediaType: found.mediaType };
    if (name === "effects_keyframe_reset") return done(unwrap(await bridge.uxp("pr.effects.reset_keyframes", { ...nativeArgs, componentMatchName: args.component_match_name, componentIndex: args.component_index, parameterIndex: args.parameter_index })));
    const inventory = unwrap(await bridge.uxp("pr.effects.inventory", nativeArgs));
    if (name !== "effects_match_parameter") return done(inventory);
    const matches = (inventory.components as Record<string, unknown>[]).filter(c => c.matchName === args.component_match_name).flatMap(c => (c.parameters as Record<string, unknown>[]).filter(p => p.displayName === args.parameter_name).map(p => ({ componentIndex: c.index, ...p })));
    if (matches.length !== 1) throw new Error("Parameter match must be unique");
    return done(matches[0]);
  }
  if (["captions_export_srt", "captions_cue_count", "captions_cue_snapshot"].includes(name)) {
    throw Object.assign(new Error("The connected native API cannot observe current caption cues and their revision. An arbitrary SRT/cues file cannot prove the current sequence state; use transcript_export_srt for an explicit transcript."), { code: "CAPTION_SOURCE_UNAVAILABLE" });
  }
  if (name === "transcript_export_srt") {
    const cues = validateCues(args.cues as CaptionCue[]);
    const output = resolve(String(args.output_path));
    if (args.srt_path && output === resolve(String(args.srt_path))) throw new Error("Output must preserve the source SRT");
    const text = serializeSrt(cues); await writeFile(output, text, { encoding: "utf8", flag: "wx" });
    return done({ exported: true, outputPath: output, cueCount: cues.length, sha256: createHash("sha256").update(text).digest("hex"), encoding: "utf-8" });
  }
  if (name === "captions_import_srt") {
    const pathValue = resolve(String(args.srt_path)), cues = parseSrt(await readFile(pathValue, "utf8"));
    if (!cues.length) throw new Error("Caption source is empty");
    const script = wrap(sequenceScript(args.sequence_id) + "var path=" + JSON.stringify(pathValue) + ";if(!app.project.importFiles([path],true,app.project.rootItem,false))throw Error('IMPORT_FAILED');var found=[];function scan(root){for(var i=0;i<root.children.numItems;i++){var x=root.children[i];if(x.children)scan(x);else if(x.getMediaPath&&String(x.getMediaPath())===path)found.push(x);}}scan(app.project.rootItem);if(found.length!==1)throw Error('CAPTION_ITEM_NOT_UNIQUE');var ok=seq.createCaptionTrack(found[0]," + Number(args.start_seconds ?? 0) + ",Sequence.CAPTION_FORMAT_SUBTITLE);if(!ok)throw Error('CAPTION_TRACK_CREATE_FAILED');return JSON.stringify({success:true,data:{created:true,sequenceId:String(seq.sequenceID),nativeTextReadback:false}});");
    const result = unwrap(await bridge.executeScript(script));
    return done({ success: false, code: "CAPTION_TEXT_READBACK_UNAVAILABLE", outcomeUnknown: true, appliedResult: result,
      error: "Native caption track was created; actual cue text and styling were not read back. Do not repeat the import automatically." });
  }
  if (name === "media_proxy_attach_all" || name === "media_batch_replace" || name === "media_set_color_label_batch") {
    return done(await batch(args.items as Record<string, unknown>[], async item => {
      const op = name === "media_proxy_attach_all" ? "pr.media.proxy" : name === "media_batch_replace" ? "pr.media.relink" : "pr.media.label";
      return unwrap(await bridge.uxp(op, { projectItemId: item.project_item_id, path: item.proxy_path ?? item.path, label: item.label }));
    }));
  }
  if (name === "media_proxy_detach_all") return done(await batch((args.item_ids as string[]).map(idValue => ({ itemKey: idValue })), async item => unwrap(await bridge.executeScript(wrap(findItemScript +
    "var item=itemById(" + JSON.stringify(item.itemKey) + ");if(typeof item.detachProxy!=='function')throw Error('PROXY_DETACH_UNAVAILABLE');item.detachProxy();if(item.hasProxy())throw Error('PROXY_DETACH_NOT_VERIFIED');return JSON.stringify({success:true,data:{detached:true,itemId:String(item.nodeId)}});")))));
  if (name === "media_consolidate_to_folder") {
    const directory = resolve(String(args.output_folder)); await mkdir(directory, { recursive: true });
    return done(await batch(args.items as Record<string, unknown>[], async item => {
      const source = resolve(String(item.source_path)), destination = join(directory, String(item.itemKey).replace(/[^A-Za-z0-9_-]/g, "_") + "-" + basename(source));
      if (source === destination) throw new Error("Consolidation source and destination must differ");
      await copyFile(source, destination, 1);
      const [original, copied] = await Promise.all([hashFile(source), hashFile(destination)]);
      if (original.sha256 !== copied.sha256 || original.sizeBytes !== copied.sizeBytes) throw new Error("Consolidated media hash mismatch");
      return { copied: true, source, destination, ...copied, relinked: false };
    }));
  }
  if (name === "sequence_duplicate_batch") return done(await batch((args.sequence_guids as string[]).map(sequenceGuid => ({ itemKey: sequenceGuid, sequenceGuid })), item => bridge.uxp("pr.sequence.duplicate", { projectGuid: args.project_guid, sequenceGuid: item.sequenceGuid })));
  if (name === "text_mogrt_apply_batch") return done(await batch(args.items as Record<string, unknown>[], item => bridge.uxp("pr.mogrt.insert", { sequenceGuid: item.sequence_guid, path: item.path, timelineStartTicks: item.ticks, videoTrackIndex: item.video_track_index, audioTrackIndex: item.audio_track_index })));
  if (name === "export_render_queue_status") return done(unwrap(await bridge.uxp("pr.export.status", { exportJobId: args.export_job_id })));
  if (name === "export_all_sequences" || name === "export_batch_ame") {
    const items = args.items as Record<string, unknown>[];
    const results = await batch(items, async item => {
      const state = unwrap(await bridge.uxp("pr.export.submit", { sequenceGuid: item.sequence_guid, outputPath: item.output_path, presetPath: item.preset_path, exportJobId: item.itemKey, queueToAME: name === "export_batch_ame" }));
      const { verification, ...job } = state;
      return { dispatchRequested: true, completed: false, job };
    });
    return done({ ...(results as Record<string, unknown>), scope: "dispatch_requests", completed: false, completionTool: "premiere_export_render_queue_status" });
  }
  if (name === "export_sequence_custom_range") {
    if (BigInt(String(args.out_ticks)) <= BigInt(String(args.in_ticks))) throw new Error("Invalid export range");
    const state = unwrap(await bridge.uxp("pr.export.submit", { sequenceGuid: args.sequence_guid, outputPath: args.output_path, presetPath: args.preset_path, exportJobId: args.export_job_id, range: { startTicks: args.in_ticks, endTicks: args.out_ticks }, fullSequence: false }));
    return done({ dispatchRequested: true, completed: false, job: state });
  }
  if (name === "playback_jump_to_next_edit" || name === "playback_jump_to_prev_edit") {
    const next = name.includes("next");
    const compare = "function cmp(a,b){a=String(a);b=String(b);var na=a.charAt(0)==='-',nb=b.charAt(0)==='-';if(na!==nb)return na?-1:1;if(na){a=a.substr(1);b=b.substr(1);}a=a.replace(/^0+(?=.)/,'');b=b.replace(/^0+(?=.)/,'');var c=a.length===b.length?(a===b?0:a<b?-1:1):a.length<b.length?-1:1;return na?-c:c;}";
    return done(unwrap(await bridge.executeScript(wrap(sequenceScript(args.sequence_id) + compare + "var now=String(seq.getPlayerPosition().ticks),best=null;for(var m=0;m<2;m++){var tracks=m?seq.audioTracks:seq.videoTracks;for(var t=0;t<tracks.numTracks;t++)for(var c=0;c<tracks[t].clips.numItems;c++){var clip=tracks[t].clips[c],points=[String(clip.start.ticks),String(clip.end.ticks)];for(var p=0;p<2;p++){var x=points[p];if(" + (next ? "cmp(x,now)>0&&(best===null||cmp(x,best)<0)" : "cmp(x,now)<0&&(best===null||cmp(x,best)>0)") + ")best=x;}}}if(best===null)throw Error('NO_EDIT_POINT');seq.setPlayerPosition(best);var actual=String(seq.getPlayerPosition().ticks);if(cmp(actual,best)!==0)throw Error('PLAYHEAD_NOT_VERIFIED');return JSON.stringify({success:true,data:{ticks:actual}});"))));
  }
  if (name === "timeline_extend_edit_to_track_end") {
    const found = unwrap(await dispatch("_find_exact_clip", args));
    const start = BigInt(String(found.startTicks)), end = BigInt(String(args.end_ticks));
    if (end <= start) throw new Error("End must follow clip start");
    const oldDuration = BigInt(String(found.endTicks)) - start, sourceDuration = BigInt(String(found.outTicks)) - BigInt(String(found.inTicks));
    const scaled = (end - start) * sourceDuration;
    if (oldDuration <= 0n || scaled % oldDuration) throw new Error("Requested end does not align to the source time map");
    return done(await dispatch("_trim_exact_clip_ticks", { ...args, source_out_ticks: (BigInt(String(found.inTicks)) + scaled / oldDuration).toString() }));
  }
  return { handled: false };
}
