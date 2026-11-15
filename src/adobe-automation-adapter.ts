import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BridgeClient } from "./server.js";
import { type AssetStore, hashFile } from "./automation/assets.js";
import { digest } from "./automation/canonical.js";
import type { MaterializingHostAdapter } from "./automation/host.js";
import type { ArtifactReceipt, ArtifactSpec, AssetRef, Capability, HostRef, Json, JsonObject, OperationReceipt, OperationRequest,
  PrClipTarget, PrProjectItemTarget, PrProjectTarget, PrSequenceTarget, PrTrackTarget, ResourceItem, ResourceOutput, TargetRef, VerificationResult } from "./automation/contracts.js";
import type { WorkerClient } from "./workers/client.js";
import { audioProfiles, encodeDb, parameterTick, observedGainEnvelope, type AudioEncodingProfile } from "./premiere/audio.js";
import { serializeSrt, type CaptionCue } from "./premiere/captions.js";
import { RetainedReceiptStore } from "./premiere/receipts.js";

type RecordValue = Record<string, unknown>;
interface NativeResult { result: RecordValue; verification?: { outcome: string; method: string } }
export interface PremiereAdapterContext {
  bridge: BridgeClient; assets: AssetStore; dataDirectory: string; installationId: string;
  worker?: WorkerClient;
  sequencePresets?: Record<string, string>;
  /** Qualified semantic-to-native parameter maps, keyed by host build and semantic operation. */
  parameterProfiles?: ParameterProfile[];
}
export interface ParameterProfile {
  id: string; hostVersion: string; semantic: string; componentMatchName: string; parameterIndex: number;
  expectedDisplayName: string; encoding: "native" | "normalized" | "percent"; multiplier?: number; offset?: number;
  keyframeClock?: "sequence" | "clip_relative" | "source";
  sourceTimeMap?: "constant_speed";
  valueShape?: "scalar" | "point_x" | "point_y" | "json_text";
  jsonTextPath?: string[];
  scaleBy?: "sequence_width" | "sequence_height";
  qualificationDigest: string;
}
export function parseParameterProfiles(value: unknown): ParameterProfile[] {
  if (!Array.isArray(value) || value.length > 256) throw coded("PARAMETER_PROFILE_INVALID", "Expected at most 256 parameter profiles");
  const profiles: ParameterProfile[] = [];
  for (const raw of value) {
    const p = record(raw);
    const allowed = new Set(["id", "hostVersion", "semantic", "componentMatchName", "parameterIndex", "expectedDisplayName", "encoding", "multiplier", "offset", "qualificationDigest", "keyframeClock", "sourceTimeMap", "valueShape", "jsonTextPath", "scaleBy"]);
    if (Object.keys(p).some(key => !allowed.has(key)) ||
      ["id", "hostVersion", "semantic", "componentMatchName", "expectedDisplayName"].some(key => typeof p[key] !== "string" || !String(p[key]).trim()) ||
      !Number.isInteger(p.parameterIndex) || Number(p.parameterIndex) < 0 ||
      !["native", "normalized", "percent"].includes(String(p.encoding)) ||
      !/^[a-f0-9]{64}$/.test(String(p.qualificationDigest)) ||
      p.keyframeClock !== undefined && !["sequence", "clip_relative", "source"].includes(String(p.keyframeClock)) ||
      p.sourceTimeMap !== undefined && p.sourceTimeMap !== "constant_speed" ||
      p.valueShape !== undefined && !["scalar", "point_x", "point_y", "json_text"].includes(String(p.valueShape)) ||
      p.scaleBy !== undefined && !["sequence_width", "sequence_height"].includes(String(p.scaleBy)) ||
      p.jsonTextPath !== undefined && (!Array.isArray(p.jsonTextPath) || !p.jsonTextPath.length || p.jsonTextPath.some(key => typeof key !== "string" || !key || ["__proto__", "constructor", "prototype"].includes(key))) ||
      p.multiplier !== undefined && !Number.isFinite(p.multiplier) || p.offset !== undefined && !Number.isFinite(p.offset)) {
      throw coded("PARAMETER_PROFILE_INVALID", "Parameter profile must identify a qualified host build and exact native parameter");
    }
    profiles.push(p as unknown as ParameterProfile);
  }
  if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw coded("PARAMETER_PROFILE_INVALID", "Duplicate parameter profile ID");
  return profiles;
}
const OPERATIONS = ["pr.project.create", "pr.project.open", "pr.project.save", "pr.sequence.create", "pr.media.import",
  "pr.timeline.inspect", "pr.timeline.edit", "pr.clip.move", "pr.clip.trim", "pr.clip.remove", "pr.audio.gain",
  "pr.effect.apply", "pr.motion.set", "pr.title.setText", "pr.captions.import", "pr.export", "pr.frame.capture"];
const READ = new Set(["pr.timeline.inspect", "pr.frame.capture"]);
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
function unpack(value: unknown): NativeResult {
  const outer = record(typeof value === "string" ? JSON.parse(value) : value);
  if (outer.success === false) throw Object.assign(coded(String(outer.code ?? "HOST_FAILED"), String(outer.error ?? "Host operation failed")), { outcomeUnknown: outer.outcomeUnknown === true, dispatchState: outer.dispatchState });
  if (outer.data !== undefined) return unpack(outer.data);
  return { result: record(outer.result ?? outer), ...(outer.verification ? { verification: outer.verification as NativeResult["verification"] } : {}) } as NativeResult;
}
function range(start: unknown, end: unknown) { return { start: { ticks: String(start) }, end: { ticks: String(end) } }; }
function clipProjection(data: RecordValue, sequenceGuid: string, sourceAssetId: string): JsonObject {
  return json({ sequenceGuid, mediaType: data.mediaType, trackIndex: data.trackIndex, sourceAssetId, sourcePath: data.mediaPath,
    sourceRange: range(data.inTicks, data.outTicks), timelineRange: range(data.startTicks, data.endTicks), speed: data.speed, reverse: data.reverse, disabled: data.disabled, name: data.name });
}
function requestDigest(req: OperationRequest): string {
  return digest(req);
}
function protectedSources(req: OperationRequest): AssetRef[] {
  const inputs = [...Object.values(req.assets), ...(Array.isArray(req.args.sourceAssets) ? req.args.sourceAssets as unknown as AssetRef[] : [])];
  return [...new Map(inputs.map(asset => [asset.rootId + ":" + asset.relativePath, asset])).values()];
}
async function verifyPng(path: string, width: number, height: number): Promise<{ bitDepth: 8 | 16; alpha: "none" | "straight" }> {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size, header = Buffer.alloc(26), footer = Buffer.alloc(12);
    if (size < 45 || (await file.read(header, 0, 26, 0)).bytesRead !== 26 || (await file.read(footer, 0, 12, size - 12)).bytesRead !== 12 ||
      header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || header.subarray(12, 16).toString() !== "IHDR" ||
      header.readUInt32BE(16) !== width || header.readUInt32BE(20) !== height || ![8, 16].includes(header[24]!) || ![2, 6].includes(header[25]!) ||
      footer.toString("hex") !== "0000000049454e44ae426082") throw coded("FRAME_FILE_NOT_VERIFIED", "Frame PNG is incomplete or has unexpected dimensions/color type");
    return { bitDepth: header[24] === 16 ? 16 : 8, alpha: header[25] === 6 ? "straight" : "none" };
  } finally { await file.close(); }
}
export function createPremiereAutomationAdapter(context: PremiereAdapterContext): MaterializingHostAdapter & { resolveHost(): Promise<HostRef> } {
  const { bridge, assets } = context;
  const active = new Map<string, { digest: string; promise: Promise<OperationReceipt> }>();
  const cancelled = new Set<string>(), imported = new Map<string, { asset: AssetRef; itemKey: string }>();
  let hostVersion = "";
  const receiptStore = new RetainedReceiptStore<OperationReceipt>(join(context.dataDirectory, "native-receipts"));
  async function persist(receipt: OperationReceipt): Promise<void> {
    await receiptStore.write(receipt);
  }
  async function getReceipt(id: string, expectedDigest?: string): Promise<OperationReceipt | null> {
    try {
      const value = await receiptStore.read(id, expectedDigest);
      if (!value) return null;
      if (["DISPATCH_INTENT", "RUNNING", "APPLIED_UNVERIFIED"].includes(value.status) && !active.has(id)) {
        const unknown: OperationReceipt = { ...value, status: "OUTCOME_UNKNOWN", effect: "unknown", dataState: "unavailable", dataSchemaId: null, data: null, dataReason: "not_observed",
          error: { code: "DAEMON_RESTART_OUTCOME_UNKNOWN", message: "A dispatched operation has no durable terminal receipt", retrySafe: false, nextAction: "read_postcondition" } };
        await persist(unknown); return unknown;
      }
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async function withRead(operation: string, args: RecordValue, hostOperation = operation): Promise<NativeResult> {
    const operationId = randomUUID();
    if (!bridge.beginOperation || !bridge.endOperation) throw coded("AUTHORITY_UNAVAILABLE", "Native reads require the daemon authority");
    await bridge.beginOperation({ operationId, toolName: operation, backend: "uxp", mode: "read", timeoutMs: 30000, queueDeadlineMs: 30000, args, itemCount: 1 });
    let finalized = false;
    try {
      const result = unpack(await bridge.uxp(hostOperation, args, undefined, { operationId, toolName: operation, backend: "uxp", mode: "read" }, 30000));
      const terminal = await bridge.endOperation(operationId, "SUCCEEDED"); finalized = true;
      if (terminal !== "SUCCEEDED") throw coded("READ_OUTCOME_UNKNOWN", "The authority could not finalize this observation");
      return result;
    } catch (error) { if (!finalized) await bridge.endOperation(operationId, "FAILED", String((error as { code?: string }).code ?? "READ_FAILED")); throw error; }
  }
  async function resolveHost(): Promise<HostRef> {
    const result = (await withRead("pr.host.inspect", {}, "host.inspect")).result;
    if (typeof result.hostEpoch !== "string" || !result.hostEpoch) throw coded("HOST_EPOCH_UNAVAILABLE", "Update the Premiere UXP plugin");
    hostVersion = String(result.hostVersion ?? "");
    return { app: "premiere", installationId: context.installationId, hostEpoch: result.hostEpoch };
  }
  async function prepare(req: OperationRequest): Promise<OperationRequest> {
    const existing = await getReceipt(req.operationId);
    if (existing) return req;
    const current = await resolveHost();
    if (current.hostEpoch !== req.host.hostEpoch || current.installationId !== req.host.installationId) throw coded("STALE_HOST", "Host changed after planning");
    if (req.target && digest(req.target.host) !== digest(req.host)) throw coded("STALE_TARGET", "Target belongs to a different host");
    const args: JsonObject = { ...req.args }, inputs = { ...req.assets };
    if (req.operation === "pr.project.open") {
      const source = inputs.source;
      if (!source) throw coded("SOURCE_REQUIRED", "Project source is required");
      if (!source.assetId.startsWith("working:")) inputs.source = await assets.stageCopy(source, req.jobId, req.revisionId);
      args.path = await assets.pathFor(inputs.source!);
    }
    if (req.operation === "pr.project.create") args.path = await assets.allocate(req.jobId, req.revisionId, req.operationId + ".prproj");
    if (req.operation === "pr.sequence.create") {
      const id = String(args.presetId ?? "");
      const path = typeof args.presetPath === "string" ? args.presetPath : context.sequencePresets?.[id];
      if (!path) throw coded("SEQUENCE_PRESET_NOT_CONFIGURED", "Configure an exact sequence preset for " + id);
      await stat(path); args.presetPath = path;
    }
    if (req.operation === "pr.media.import") {
      args.items = await Promise.all((args.items as JsonObject[]).map(async item => {
        const input = inputs[String(item.inputKey)];
        if (!input) throw coded("MEDIA_INPUT_NOT_FOUND", String(item.inputKey));
        return { ...item, path: await assets.pathFor(input) };
      }));
    }
    if (["pr.export", "pr.project.save"].includes(req.operation)) {
      const output = args.output as unknown as ArtifactSpec;
      if (!output?.outputKey) throw coded("OUTPUT_REQUIRED", "A normalized ArtifactSpec is required");
      args.outputPath = await assets.allocate(req.jobId, req.revisionId, req.operationId + "." + output.format.replace(/^\./, ""));
      if (req.operation === "pr.project.save") args.path = args.outputPath;
      if (req.operation === "pr.export") {
        const resolved = record(args.resolvedEncoding);
        const preset = (resolved.presetAsset as AssetRef | undefined) ?? inputs.encoderPreset ?? inputs.preset;
        if (preset) args.presetPath = await assets.pathFor(preset);
        if (!args.presetPath) throw coded("PRESET_NOT_CONFIGURED", "Export requires a pinned preset asset");
        if (!context.worker) throw coded("MEDIA_WORKER_REQUIRED", "Output format verification requires the local media worker");
      }
    }
    if (req.operation === "pr.frame.capture") args.outputPath = await assets.allocate(req.jobId, req.revisionId, req.operationId + ".png");
    if (req.operation === "pr.captions.import") {
      args.srtPath = await assets.allocate(req.jobId, req.revisionId, req.operationId + ".srt");
      const srt = serializeSrt(args.cues as unknown as CaptionCue[]);
      try { await writeFile(String(args.srtPath), srt, { encoding: "utf8", flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(String(args.srtPath), "utf8") !== srt) throw error;
      }
    }
    return { ...req, args, assets: inputs };
  }
  function initial(req: OperationRequest): OperationReceipt {
    return { operationId: req.operationId, requestDigest: requestDigest(req), host: req.host, status: "DISPATCH_INTENT", effect: "not_applied",
      ...(req.target ? { targetBefore: req.target } : {}), dataState: "unavailable", dataSchemaId: null, data: null, dataReason: "not_started",
      resources: {}, verification: [], evidence: [], recovery: { authorityId: req.executionNamespaceId, authorityGeneration: req.host.hostEpoch, savedThroughOperationIds: [], effectEvidence: "none" },
      artifacts: [], cancelRequested: false, timestamps: { accepted: new Date().toISOString() } };
  }
  async function native(req: OperationRequest, operation: string, args: RecordValue, mode: "read" | "mutate"): Promise<NativeResult> {
    return unpack(await bridge.uxp(operation, { ...args, expectedHostEpoch: req.host.hostEpoch }, undefined, { operationId: req.operationId, toolName: req.operation, backend: "uxp", mode }, Math.min(120000, Math.max(1000, req.waitTimeoutMs))));
  }
  function afterOwnClipEdit(req: OperationRequest, args: RecordValue, result: NativeResult): RecordValue {
    const handle = record(result.result.handle);
    if (result.verification?.outcome !== "verified" || typeof handle.$ref !== "string" || !handle.$ref || handle.session !== req.host.hostEpoch ||
      req.target?.kind !== "pr_clip" || handle.projectGuid !== req.target.projectGuid || handle.sequenceGuid !== req.target.sequenceGuid) {
      throw Object.assign(coded("EDITED_TARGET_HANDLE_UNAVAILABLE", "A successful native edit must return a fresh exact clip handle before another parameter is changed"), { outcomeUnknown: true });
    }
    // Only this operation's verified native result advances its local binding.
    // The original target and its owner-preserved baseline remain immutable.
    return { ...args, trackItem: handle };
  }
  async function cep(req: OperationRequest, script: string, mode: "read" | "mutate"): Promise<RecordValue> {
    return unpack(await bridge.executeScript(script, Math.min(120000, Math.max(1000, req.waitTimeoutMs)), { operationId: req.operationId, toolName: req.operation, backend: "cep", mode })).result;
  }
  async function clipTarget(req: OperationRequest, data: RecordValue, index: number): Promise<PrClipTarget> {
    const handle = record(data.handle), projectGuid = String(handle.projectGuid ?? record(req.target).projectGuid), sequenceGuid = String(handle.sequenceGuid ?? record(req.target).sequenceGuid);
    let source = imported.get(projectGuid + ":" + String(data.projectItemId))?.asset;
    if (!source && typeof data.mediaPath === "string" && data.mediaPath) {
      try { source = await assets.registerGenerated(data.mediaPath); } catch { /* A native project may reference an unregistered source root; do not fabricate a hash. */ }
    }
    const old = index === 0 && req.target?.kind === "pr_clip" ? req.target : undefined;
    if (!source && !old) throw coded("SOURCE_ASSET_UNRESOLVED", "Register the native clip's media root before using it in a workflow");
    return { kind: "pr_clip", host: req.host, projectGuid, sequenceGuid,
      workingAssetId: req.target && "workingAssetId" in req.target ? req.target.workingAssetId : req.assets.source?.assetId ?? "working:" + req.jobId,
      mediaType: data.mediaType === "audio" ? "audio" : "video", trackIndex: Number(data.trackIndex),
      trackFingerprint: typeof data.trackFingerprint === "string" ? data.trackFingerprint : old?.trackFingerprint ?? digest([projectGuid, sequenceGuid, data.mediaType, data.trackIndex]),
      clipKey: old?.clipKey ?? String(data.itemKey ?? "clip-" + digest([projectGuid, sequenceGuid, data.mediaType, data.trackIndex, data.projectItemId, data.startTicks, data.inTicks]).slice(0, 24)),
      sourceAssetId: source?.assetId ?? old!.sourceAssetId, ...(handle.$ref ? { uxpHandleId: String(handle.$ref) } : {}),
      sourceRange: range(data.inTicks, data.outTicks), timelineRange: range(data.startTicks, data.endTicks),
      structuralFingerprint: digest(clipProjection(data, sequenceGuid, source?.assetId ?? old!.sourceAssetId)) };
  }
  const clipState = (target: PrClipTarget): JsonObject => json({ clipKey: target.clipKey, sourceAssetId: target.sourceAssetId, sourceRange: target.sourceRange,
    timelineRange: target.timelineRange, mediaType: target.mediaType, trackIndex: target.trackIndex });
  function single(kind: "project" | "sequence" | "clip" | "artifact", itemKey: string, value: TargetRef | ArtifactReceipt): ResourceOutput {
    return { kind: "single", resourceKind: kind, item: { itemKey, value } };
  }
  function selectedProfile(semantic: string): ParameterProfile {
    const profiles = (context.parameterProfiles ?? []).filter(p => p.semantic === semantic && p.hostVersion === hostVersion && /^[a-f0-9]{64}$/.test(p.qualificationDigest));
    if (profiles.length !== 1) throw coded("PARAMETER_PROFILE_UNAVAILABLE", "No unique qualified native parameter profile for " + semantic + " on " + hostVersion);
    return profiles[0]!;
  }
  const timeMapProfile = (mediaType: string): RecordValue | undefined => {
    const candidates = (context.parameterProfiles ?? []).filter(p => p.hostVersion === hostVersion && p.semantic === "time_remap." + mediaType);
    if (candidates.length !== 1) return undefined;
    const profile = candidates[0]!;
    return { componentMatchName: profile.componentMatchName, parameterIndex: profile.parameterIndex, expectedDisplayName: profile.expectedDisplayName };
  };
  async function constantState(req: OperationRequest, mode: "read" | "mutate"): Promise<Parameters<typeof parameterTick>[1]> {
    const state = (await native(req, "pr.clip.inspect", { target: req.target }, mode)).result;
    if (state.timeMapKind !== "constant_speed") {
      const profile = timeMapProfile(String(state.mediaType));
      if (!profile) throw coded("TIME_MAP_UNQUALIFIED", "Existing clips require an intrinsic retime parameter profile for source-clock keyframes");
      await native(req, "pr.clip.qualify_time_map", { target: req.target, ...profile }, mode);
    }
    return state as unknown as Parameters<typeof parameterTick>[1];
  }
  async function linkedBindings(req: OperationRequest, mode: "read" | "mutate"): Promise<RecordValue[]> {
    if (req.target?.kind !== "pr_clip") return [];
    const target = req.target;
    const overview = (await native(req, "project.inspect", {}, mode)).result;
    if (record(overview.project).guid !== target.projectGuid) throw coded("LINK_PROJECT_NOT_ACTIVE", "Linked-item lookup requires the exact active project");
    const sequence = (overview.sequences as RecordValue[]).find(s => s.guid === target.sequenceGuid);
    if (!sequence) throw coded("LINK_SEQUENCE_NOT_FOUND", "Linked-item sequence is unavailable");
    const source = { startTicks: target.timelineRange.start.ticks, endTicks: target.timelineRange.end.ticks, inTicks: target.sourceRange.start.ticks, outTicks: target.sourceRange.end.ticks };
    const script = "(function(){try{var seq=null,name=" + JSON.stringify(sequence.name) + ";for(var s=0;s<app.project.sequences.numSequences;s++)if(String(app.project.sequences[s].name)===name){if(seq)throw Error('SEQUENCE_NOT_UNIQUE');seq=app.project.sequences[s];}if(!seq)throw Error('SEQUENCE_NOT_FOUND');var tracks=seq." + (target.mediaType === "video" ? "videoTracks" : "audioTracks") + ",track=tracks[" + target.trackIndex + "],want=" + JSON.stringify(source) + ",matches=[];for(var c=0;track&&c<track.clips.numItems;c++){var x=track.clips[c];if(String(x.start.ticks)===want.startTicks&&String(x.end.ticks)===want.endTicks&&String(x.inPoint.ticks)===want.inTicks&&String(x.outPoint.ticks)===want.outTicks)matches.push(x);}if(matches.length!==1)throw Error('CLIP_NOT_UNIQUE');if(typeof matches[0].getLinkedItems!=='function')throw Error('LINK_MEMBERSHIP_UNAVAILABLE');var links=matches[0].getLinkedItems(),out=[];for(var m=0;m<2;m++){var ts=m?seq.audioTracks:seq.videoTracks;for(var t=0;t<ts.numTracks;t++)for(var c=0;c<ts[t].clips.numItems;c++){var x=ts[t].clips[c];for(var l=0;links&&l<links.numItems;l++)if(String(x.nodeId)===String(links[l].nodeId))out.push({mediaType:m?'audio':'video',trackIndex:t,startTicks:String(x.start.ticks),endTicks:String(x.end.ticks),inTicks:String(x.inPoint.ticks),outTicks:String(x.outPoint.ticks),mediaPath:x.projectItem?String(x.projectItem.getMediaPath()):''});}}return JSON.stringify({success:true,data:{items:out}});}catch(e){return JSON.stringify({success:false,code:'LINK_BINDING_FAILED',error:String(e)});}})();";
    return (await cep(req, script, mode)).items as RecordValue[];
  }
  async function run(req: OperationRequest): Promise<OperationReceipt> {
    const prior = await getReceipt(req.operationId, requestDigest(req));
    if (prior) {
      if (prior.requestDigest !== requestDigest(req)) throw coded("IDEMPOTENCY_CONFLICT", "Operation ID already represents different input");
      return prior;
    }
    let receipt = initial(req);
    await persist(receipt);
    if (cancelled.has(req.operationId)) { receipt = { ...receipt, status: "CANCELLED_NO_EFFECT", cancelRequested: true }; await persist(receipt); return receipt; }
    const mode = READ.has(req.operation) ? "read" : "mutate";
    let began = false, dispatched = false, effectObserved = false;
    try {
      if (!bridge.beginOperation || !bridge.endOperation) throw coded("AUTHORITY_UNAVAILABLE", "Native writes require the daemon authority");
      await bridge.beginOperation({ operationId: req.operationId, toolName: req.operation, backend: "uxp", mode, timeoutMs: 120000, queueDeadlineMs: 30000, args: req.args, itemCount: 1 });
      began = true;
      receipt = { ...receipt, status: "RUNNING", timestamps: { ...receipt.timestamps, dispatched: new Date().toISOString() } };
      await persist(receipt);
      let args: RecordValue = { ...req.args, ...(req.target ? { target: req.target } : {}) }, nativeOperation = req.operation;
      let audioContext: { profile: AudioEncodingProfile; state: Parameters<typeof parameterTick>[1] } | undefined;
      if (req.expectedBefore) {
        if (digest(req.expectedBefore.fields) !== req.expectedBefore.digest) throw coded("EXPECTED_STATE_INVALID", "Expected projection digest does not match its fields");
        if (req.target?.kind !== "pr_clip") throw coded("EXPECTED_STATE_SCOPE_UNSUPPORTED", "Only explicit clip projection fields are supported by this adapter");
        const observed = (await native(req, "pr.clip.inspect", { target: req.target }, mode)).result;
        const projection = json({ projectGuid: req.target.projectGuid, sequenceGuid: req.target.sequenceGuid, mediaType: observed.mediaType, trackIndex: observed.trackIndex,
          sourceRange: range(observed.inTicks, observed.outTicks), timelineRange: range(observed.startTicks, observed.endTicks), speed: observed.speed, reverse: observed.reverse, disabled: observed.disabled, name: observed.name });
        for (const [key, expected] of Object.entries(req.expectedBefore.fields)) {
          if (!(key in projection)) throw coded("EXPECTED_STATE_SCOPE_UNSUPPORTED", "Unknown clip projection field " + key);
          if (digest(projection[key]) !== digest(expected)) throw coded("EXPECTED_STATE_CHANGED", "Observed clip field changed: " + key);
        }
      }
      if (["pr.clip.move", "pr.clip.trim", "pr.clip.remove"].includes(req.operation) && args.linkedPolicy === "preserve") args.linkedItems = await linkedBindings(req, mode);
      if (req.operation === "pr.clip.move") args.targetTrackIndex = args.trackIndex;
      if (req.operation === "pr.clip.trim") {
        args.anchor = args.anchor === "sequence_end" ? "sequence-end" : "sequence-start";
        if (req.target?.kind === "pr_clip") { args.timeMapProfile = timeMapProfile(req.target.mediaType); args.linkTimeMapProfile = timeMapProfile(req.target.mediaType === "video" ? "audio" : "video"); }
      }
      if (req.operation === "pr.audio.gain") {
        const inventory = await native(req, "pr.effects.inventory", args, mode), components = inventory.result.components as RecordValue[];
        const profiles = (await audioProfiles()).filter(p => p.route === "uxp" && p.hostVersion === hostVersion && (!args.encodingProfile || p.id === args.encodingProfile));
        const matches = profiles.flatMap(profile => components.filter(c => c.matchName === profile.componentMatchName).flatMap(c =>
          (c.parameters as RecordValue[]).filter(p => String(p.index) === profile.parameterIdentity || p.displayName === profile.parameterIdentity).map(p => ({ profile, component: c, parameter: p }))));
        if (matches.length !== 1) throw coded("AUDIO_PARAMETER_ENCODING_UNKNOWN", "Configure a qualified UXP gain parameter profile");
        const found = matches[0]!;
        const clipState = Array.isArray(args.keyframes) && args.keyframes.length ? found.profile.keyframeClock === "source" ? await constantState(req, mode) : (await native(req, "pr.clip.inspect", { target: req.target }, mode)).result : undefined;
        if (clipState) audioContext = { profile: found.profile, state: clipState as unknown as Parameters<typeof parameterTick>[1] };
        args = { ...args, componentMatchName: found.profile.componentMatchName, componentIndex: found.component.index, parameterIndex: found.parameter.index,
          expectedDisplayName: found.parameter.displayName, value: encodeDb(Number(args.db), found.profile), mode: audioContext ? "replace_keyframes" : "static",
          ...(Array.isArray(args.keyframes) ? { keyframes: (args.keyframes as RecordValue[]).map(k => ({ ticks: parameterTick(String(k.ticks), clipState as unknown as Parameters<typeof parameterTick>[1], found.profile), value: encodeDb(Number(k.db), found.profile), interpolation: "linear" })) } : {}) };
      }
      if (req.operation === "pr.title.setText" || req.operation === "pr.motion.set") {
        const profile = selectedProfile(req.operation === "pr.title.setText" ? "title.text" : "motion." + String(args.property));
        nativeOperation = "pr.parameter.set";
        const clipState = Array.isArray(args.keyframes) && args.keyframes.length ? profile.keyframeClock === "source" ? await constantState(req, mode) : (await native(req, "pr.clip.inspect", { target: req.target }, mode)).result : undefined;
        const components = (await native(req, "pr.effects.inventory", args, mode)).result.components as RecordValue[];
        const parameters = components.filter(component => component.matchName === profile.componentMatchName).flatMap(component => (component.parameters as RecordValue[]).filter(parameter => parameter.index === profile.parameterIndex && parameter.displayName === profile.expectedDisplayName));
        if (parameters.length !== 1) throw coded("PARAMETER_IDENTITY_MISMATCH", "Qualified creative parameter was not found uniquely");
        const parameter = parameters[0]!, baseValue = parameter.value;
        if ((profile.valueShape === "point_x" || profile.valueShape === "point_y") && parameter.timeVarying) throw coded("COMPOSITE_ANIMATION_PRESERVATION_UNAVAILABLE", "An animated native Point parameter cannot be rewritten as one independent axis without preserving its complete curve");
        if (req.operation === "pr.title.setText" && args.preserveAnimation === true && parameter.timeVarying) throw coded("TEXT_ANIMATION_PRESERVATION_UNAVAILABLE", "Animated text requires a qualified complete-curve provider");
        let scale = 1;
        if (profile.scaleBy) {
          if (req.target?.kind !== "pr_clip") throw coded("TARGET_REQUIRED", "A sequence-bound clip is required");
          const sequenceGuid = req.target.sequenceGuid;
          const view = (await native(req, "pr.timeline.inspect", { target: req.target }, mode)).result;
          const sequence = (view.sequences as RecordValue[]).find(sequence => sequence.sequenceGuid === sequenceGuid);
          scale = Number(record(sequence?.frameSize)[profile.scaleBy === "sequence_width" ? "width" : "height"]);
          if (!Number.isFinite(scale) || scale <= 0) throw coded("SEQUENCE_DIMENSIONS_UNAVAILABLE", "Native coordinate scale could not be observed");
        }
        const encode = (value: unknown): unknown => {
          if (req.operation === "pr.title.setText") {
            if (typeof baseValue !== "string") throw coded("TEXT_PARAMETER_SHAPE_UNKNOWN", "Native text is not a string");
            if (profile.valueShape === "json_text") {
              if (!profile.jsonTextPath?.length) throw coded("TEXT_PARAMETER_PROFILE_INVALID", "JSON text profile requires an exact property path");
              const payload = JSON.parse(baseValue) as RecordValue; let current = payload;
              for (const key of profile.jsonTextPath.slice(0, -1)) { const next = current[key]; if (!next || typeof next !== "object" || Array.isArray(next)) throw coded("TEXT_PARAMETER_PATH_MISSING", key); current = next as RecordValue; }
              const key = profile.jsonTextPath.at(-1)!; if (typeof current[key] !== "string") throw coded("TEXT_PARAMETER_PATH_MISSING", key);
              current[key] = String(value); return JSON.stringify(payload);
            }
            if (/^\s*[\[{]/.test(baseValue)) throw coded("TEXT_JSON_PROFILE_REQUIRED", "A structured MOGRT text payload requires an exact JSON text profile");
            return String(value);
          }
          const numeric = Number(value) * scale * (profile.multiplier ?? 1) + (profile.offset ?? 0);
          if (!Number.isFinite(numeric)) throw coded("PARAMETER_VALUE_INVALID", "Numeric parameter value is not finite");
          if (profile.valueShape === "point_x" || profile.valueShape === "point_y") {
            const point = record(baseValue);
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw coded("PARAMETER_POINT_SHAPE_UNKNOWN", "Native point coordinates are not available");
            return { x: point.x, y: point.y, [profile.valueShape === "point_x" ? "x" : "y"]: numeric };
          }
          if (typeof baseValue !== "number") throw coded("PARAMETER_VALUE_SHAPE_UNKNOWN", "Scalar mapping cannot overwrite a compound native value");
          return numeric;
        };
        args = { ...args, componentMatchName: profile.componentMatchName, parameterIndex: profile.parameterIndex, expectedDisplayName: profile.expectedDisplayName,
          ...(req.operation === "pr.title.setText" ? { value: encode(args.text) } : args.value !== undefined ? { value: encode(args.value) } : {}),
          ...(Array.isArray(args.keyframes) ? { keyframes: (args.keyframes as RecordValue[]).map(k => ({ ticks: parameterTick(String(k.ticks), clipState as unknown as Parameters<typeof parameterTick>[1], profile), value: encode(k.value), interpolation: k.interpolation })) } : {}) };
      }
      if (req.operation === "pr.effect.apply") {
        const effect = record(args.effect), semantic = String(effect.name), fields = Object.keys(effect).filter(k => k !== "name");
        const profiles = fields.map(field => ({ field, profile: selectedProfile("effect." + semantic + "." + field) }));
        if (!profiles.length || new Set(profiles.map(p => p.profile.componentMatchName)).size !== 1) throw coded("EFFECT_PROFILE_INVALID", "Effect parameters require one qualified component");
        const matchName = profiles[0]!.profile.componentMatchName;
        const existing = (await native(req, "pr.effects.inventory", args, mode)).result.components as RecordValue[];
        const matches = existing.filter(c => c.matchName === matchName);
        if (matches.length > 1) throw coded("EFFECT_AMBIGUOUS", "Choose an exact effect instance");
        if (!matches.length) {
          if (args.existingEffectPolicy !== "create_if_absent") throw coded("EFFECT_NOT_FOUND", matchName);
          dispatched = true; const appended = await native(req, "pr.effect.apply", { ...args, matchName }, mode); effectObserved = true;
          args = afterOwnClipEdit(req, args, appended);
        }
        let last: NativeResult | undefined;
        const changes: JsonObject[] = [];
        for (const { field, profile } of profiles) {
          const requested = effect[field], value = typeof requested === "number" ? requested * (profile.multiplier ?? 1) + (profile.offset ?? 0) : requested;
          args = { ...args, componentMatchName: matchName, parameterIndex: profile.parameterIndex, expectedDisplayName: profile.expectedDisplayName, value, mode: "static" };
          dispatched = true; last = await native(req, "pr.parameter.set", args, mode); effectObserved = true;
          changes.push(json({ field, parameterMatchName: profile.expectedDisplayName, requestedValue: requested, nativeValue: value, readbackValue: (last.result.values as RecordValue[])[0]!.value }));
          args = afterOwnClipEdit(req, args, last);
        }
        args.parameterChanges = changes;
        return await complete(req, receipt, last!, args, mode, began);
      }
      if (req.operation === "pr.frame.capture") {
        const proxy = await cep(req, "(function(){if(typeof app.getEnableProxies!=='function')return JSON.stringify({success:false,code:'PROXY_STATE_UNAVAILABLE'});var p=app.getEnableProxies();return JSON.stringify({success:true,data:{proxy:p}});})();", mode);
        if (proxy.proxy !== 0 && proxy.proxy !== 1) throw coded("PROXY_STATE_UNAVAILABLE", "Proxy state was not 0 or 1");
        args.isProxy = proxy.proxy === 1;
      }
      let outcome: NativeResult;
      if (req.operation === "pr.captions.import") {
        // CEP exposes native caption placement; text is read from the exact imported sidecar, never sequence markers.
        const target = req.target as PrSequenceTarget;
        const project = (await native(req, "project.inspect", {}, mode)).result;
        const sequence = (project.sequences as RecordValue[]).find(s => s.guid === target.sequenceGuid);
        if (!sequence) throw coded("SEQUENCE_BINDING_UNAVAILABLE", "Target sequence missing");
        const path = String(args.srtPath), name = String(sequence.name);
        const script = "(function(){try{var p=app.project,seqs=[];for(var i=0;i<p.sequences.numSequences;i++)if(String(p.sequences[i].name)===" + JSON.stringify(name) + ")seqs.push(p.sequences[i]);if(seqs.length!==1)throw Error('SEQUENCE_BINDING_NOT_UNIQUE');var path=" + JSON.stringify(path) + ";if(!p.importFiles([path],true,p.rootItem,false))throw Error('CAPTION_IMPORT_FAILED');var found=[];function walk(root){for(var j=0;j<root.children.numItems;j++){var x=root.children[j];if(x.children)walk(x);else if(x.getMediaPath&&String(x.getMediaPath())===path)found.push(x);}}walk(p.rootItem);if(found.length!==1)throw Error('CAPTION_ITEM_NOT_UNIQUE');if(!seqs[0].createCaptionTrack(found[0],0,Sequence.CAPTION_FORMAT_SUBTITLE))throw Error('CAPTION_TRACK_CREATE_FAILED');return JSON.stringify({success:true,data:{created:true,sequenceId:String(seqs[0].sequenceID)}});}catch(e){return JSON.stringify({success:false,code:'CAPTION_IMPORT_NOT_VERIFIED',outcomeUnknown:true,error:String(e)});}})();";
        dispatched = true;
        outcome = { result: await cep(req, script, mode), verification: { outcome: "committed_unverified", method: "Native caption track created from exact SRT; native cue text readback requires a qualified caption provider" } };
        effectObserved = true;
      } else if (req.operation === "pr.export") {
        dispatched = true;
        const exportArgs = { ...args, exportJobId: req.operationId };
        await native(req, "pr.export.submit", exportArgs, mode);
        effectObserved = true;
        const deadline = Date.parse(req.executionDeadline);
        let previousFile: string | undefined, stableSamples = 0;
        for (;;) {
          outcome = await native(req, "pr.export.status", { exportJobId: req.operationId, ...(req.target ? { target: req.target } : {}) }, mode);
          if (outcome.result.status === "SUCCEEDED" || outcome.result.status === "DISPATCH_RETURNED") break;
          if (["FAILED", "CANCELLED"].includes(String(outcome.result.status))) throw Object.assign(coded("EXPORT_FAILED", String(outcome.result.error ?? outcome.result.status)), { outcomeUnknown: false, effect: "applied" });
          if (outcome.result.queueToAME === false) {
            try {
              const file = await stat(String(args.outputPath)), signature = file.size + ":" + file.mtimeMs;
              stableSamples = file.size > 0 && signature === previousFile ? stableSamples + 1 : 0; previousFile = signature;
              if (stableSamples >= 2) break;
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
          if (Date.now() >= deadline) throw Object.assign(coded("EXPORT_OUTCOME_UNKNOWN", "No matching terminal encoder event before deadline"), { outcomeUnknown: true });
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } else {
        dispatched = true;
        outcome = await native(req, nativeOperation, args, mode);
        effectObserved = mode === "mutate";
      }
      return await complete(req, receipt, outcome, args, mode, began, audioContext);
    } catch (error) {
      const e = error as { code?: string; outcomeUnknown?: boolean; effect?: string; message?: string; dispatchState?: string };
      if (e.dispatchState === "not_dispatched" && !effectObserved) dispatched = false;
      const unknown = e.outcomeUnknown === true || dispatched && /TIMEOUT|DISCONNECT|CLOSED|UNKNOWN/.test(String(e.code));
      const status = unknown ? "OUTCOME_UNKNOWN" : dispatched && mode === "mutate" ? "FAILED_WITH_EFFECT" : "FAILED_NO_EFFECT";
      receipt = { ...receipt, status, effect: unknown ? "unknown" : dispatched && mode === "mutate" ? "partial" : "not_applied",
        dataState: "unavailable", dataSchemaId: null, data: null, dataReason: "not_observed", cancelRequested: cancelled.has(req.operationId),
        error: { code: String(e.code ?? "NATIVE_OPERATION_FAILED"), message: String(e.message ?? error), retrySafe: !dispatched, nextAction: unknown ? "read_postcondition" : dispatched ? "restore_owned_checkpoint" : "new_plan" },
        timestamps: { ...receipt.timestamps, finalized: new Date().toISOString() } };
      if (began) {
        try {
          const terminal = await bridge.endOperation!(req.operationId, unknown ? "UNKNOWN" : "FAILED", receipt.error!.code);
          if (terminal === "UNKNOWN") receipt = { ...receipt, status: "OUTCOME_UNKNOWN", effect: "unknown" };
        } catch { receipt = { ...receipt, status: "OUTCOME_UNKNOWN", effect: "unknown" }; }
      }
      await persist(receipt); return receipt;
    }
  }
  async function complete(req: OperationRequest, receipt: OperationReceipt, outcome: NativeResult, args: RecordValue, mode: "read" | "mutate", began: boolean, audioContext?: { profile: AudioEncodingProfile; state: Parameters<typeof parameterTick>[1] }): Promise<OperationReceipt> {
    const r = outcome.result, resources: Record<string, ResourceOutput> = {};
    const artifacts: ArtifactReceipt[] = [];
    let data: JsonObject = {}, schema = "query.inventory.v1", targetAfter: TargetRef | undefined;
    const verification: VerificationResult[] = [{ assertionId: req.operationId + ":native", status: outcome.verification?.outcome === "verified" ? "pass" : "not_run", method: outcome.verification?.method ?? "Host response without readback" }];
    if (outcome.verification?.outcome !== "verified") {
      const unverified: OperationReceipt = { ...receipt, status: "APPLIED_UNVERIFIED", effect: "applied", dataState: "unavailable", dataSchemaId: null, data: null, dataReason: "not_observed", verification,
        error: { code: "POSTCONDITION_UNAVAILABLE", message: verification[0]!.method, retrySafe: false, nextAction: "read_postcondition" } };
      await bridge.endOperation!(req.operationId, "UNKNOWN", "POSTCONDITION_UNAVAILABLE");
      const unknown: OperationReceipt = { ...unverified, status: "OUTCOME_UNKNOWN" }; await persist(unknown); return unknown;
    }
    const workingAssetId = req.assets.source?.assetId ?? (req.target && "workingAssetId" in req.target ? req.target.workingAssetId : "working:" + req.jobId);
    if (["pr.project.open", "pr.project.create"].includes(req.operation)) {
      const target: PrProjectTarget = { kind: "pr_project", host: req.host, projectGuid: String(r.projectGuid), workingAssetId };
      targetAfter = target; resources.project = single("project", "project", target); data = { resourceSlot: "project", totalReturned: 1, complete: true };
    } else if (req.operation === "pr.sequence.create") {
      const target: PrSequenceTarget = { kind: "pr_sequence", host: req.host, projectGuid: String(r.projectGuid), sequenceGuid: String(r.sequenceGuid), workingAssetId };
      targetAfter = target; resources.sequence = single("sequence", "sequence", target); data = { resourceSlot: "sequence", totalReturned: 1, complete: true };
    } else if (req.operation === "pr.media.import") {
      schema = "media.import.v1";
      const items: ResourceItem[] = [], rows: JsonObject[] = [];
      for (const row of r.items as RecordValue[]) {
        const input = (req.args.items as JsonObject[]).find(i => i.itemKey === row.itemKey)!;
        const source = req.assets[String(input.inputKey)]!;
        const target: PrProjectItemTarget = { kind: "pr_project_item", host: req.host, projectGuid: String(row.projectGuid), workingAssetId, projectItemId: String(row.projectItemId), sourceAssetId: source.assetId };
        imported.set(target.projectGuid + ":" + target.projectItemId, { asset: source, itemKey: String(row.itemKey) });
        items.push({ itemKey: String(row.itemKey), value: target }); rows.push({ inputKey: String(input.inputKey), itemKey: String(row.itemKey), resourceSlot: "items", sourceAssetId: source.assetId });
      }
      resources.items = { kind: "collection", resourceKind: "project_item", items, complete: true }; data = { items: rows, skippedInputKeys: [] };
    } else if (["pr.timeline.inspect", "pr.timeline.edit", "pr.clip.move", "pr.clip.trim", "pr.clip.remove"].includes(req.operation)) {
      const sourceRows = (Array.isArray(r.clips) ? r.clips : r.after ? [{ ...record(r.after), handle: r.handle }, ...((r.linkedAfter ?? []) as RecordValue[])] : []) as RecordValue[];
      const nativeTracks = (Array.isArray(r.tracks) ? r.tracks : []) as RecordValue[];
      const trackProjections = new Map<string, JsonObject>();
      const trackFingerprints = new Map(nativeTracks.map(track => {
        const key = String(track.sequenceGuid) + ":" + String(track.mediaType) + ":" + String(track.trackIndex);
        const content = sourceRows.filter(row => row.sequenceGuid === track.sequenceGuid && row.mediaType === track.mediaType && row.trackIndex === track.trackIndex)
          .map(({ handle, ...row }) => row);
        const projection = json({ ...track, clips: content }); trackProjections.set(key, projection);
        return [key, digest(projection)] as const;
      }));
      for (const row of sourceRows) {
        const fingerprint = trackFingerprints.get(String(row.sequenceGuid) + ":" + String(row.mediaType) + ":" + String(row.trackIndex));
        if (fingerprint) row.trackFingerprint = fingerprint;
      }
      const targets = await Promise.all(sourceRows.map((row, i) => clipTarget(req, row, i)));
      resources.clips = { kind: "collection", resourceKind: "clip", items: targets.map((t, i) => ({ itemKey: t.clipKey, value: t,
        structuralFingerprint: t.structuralFingerprint, projectionVersion: 1, projection: clipProjection(sourceRows[i]!, t.sequenceGuid, t.sourceAssetId) })), complete: true };
      targetAfter = targets[0];
      if (req.operation === "pr.timeline.inspect") {
        resources.sequences = { kind: "collection", resourceKind: "sequence", complete: true, items: ((r.sequences ?? []) as RecordValue[]).map(sequence => {
          const target: PrSequenceTarget = { kind: "pr_sequence", host: req.host, projectGuid: String(r.projectGuid), sequenceGuid: String(sequence.sequenceGuid), workingAssetId };
          const projection = json({ ...sequence, tracks: nativeTracks.filter(t => t.sequenceGuid === target.sequenceGuid) });
          return { itemKey: target.sequenceGuid, value: target, structuralFingerprint: digest(projection), projectionVersion: 1, projection };
        }) };
        resources.tracks = { kind: "collection", resourceKind: "track", complete: true, items: nativeTracks.map(track => {
          const key = String(track.sequenceGuid) + ":" + String(track.mediaType) + ":" + String(track.trackIndex);
          const target: PrTrackTarget = { kind: "pr_track", host: req.host, projectGuid: String(r.projectGuid), sequenceGuid: String(track.sequenceGuid), workingAssetId,
            mediaType: track.mediaType === "audio" ? "audio" : "video", trackIndex: Number(track.trackIndex), trackFingerprint: trackFingerprints.get(key)! };
          return { itemKey: key, value: target, structuralFingerprint: target.trackFingerprint, projectionVersion: 1, projection: trackProjections.get(key)! };
        }) };
        const projectTarget: PrProjectTarget = { kind: "pr_project", host: req.host, projectGuid: String(r.projectGuid), workingAssetId };
        const projectProjection = json({ projectGuid: r.projectGuid, sequences: resources.sequences.items.map(item => ({ itemKey: item.itemKey, structuralFingerprint: item.structuralFingerprint })) });
        resources.project = { kind: "single", resourceKind: "project", item: { itemKey: "project", value: projectTarget, projectionVersion: 1, projection: projectProjection, structuralFingerprint: digest(projectProjection) } };
        const mediaItems: ResourceItem[] = [];
        for (const nativeItem of (r.mediaItems ?? []) as RecordValue[]) {
          const source = await assets.registerGenerated(String(nativeItem.mediaPath));
          const target: PrProjectItemTarget = { kind: "pr_project_item", host: req.host, projectGuid: String(r.projectGuid), workingAssetId, projectItemId: String(nativeItem.projectItemId), sourceAssetId: source.assetId };
          const projection = json({ projectItemId: nativeItem.projectItemId, name: nativeItem.name, sourcePath: nativeItem.mediaPath, sourceAssetId: source.assetId });
          imported.set(target.projectGuid + ":" + target.projectItemId, { asset: source, itemKey: target.projectItemId });
          mediaItems.push({ itemKey: target.projectItemId, value: target, projectionVersion: 1, projection, structuralFingerprint: digest(projection) });
        }
        resources.items = { kind: "collection", resourceKind: "project_item", items: mediaItems, complete: true };
        data = { resourceSlot: "clips", totalReturned: targets.length, complete: true };
      }
      else { schema = "pr.timeline_edit.v1"; data = { changed: true, before: req.target?.kind === "pr_clip" ? [clipState(req.target)] : [],
        after: targets.map(clipState), removedClipKeys: req.operation === "pr.clip.remove" && req.target?.kind === "pr_clip" ? [req.target.clipKey] : [], linkedClipKeys: targets.slice(1).map(target => target.clipKey), rippleApplied: args.ripple === true }; }
    } else if (["pr.audio.gain", "pr.effect.apply", "pr.motion.set", "pr.title.setText"].includes(req.operation)) {
      schema = "pr.parameter_change.v1";
      const target = await clipTarget(req, { ...record(r.after), handle: r.handle }, 0); targetAfter = target;
      resources.clip = single("clip", target.clipKey, target);
      const readback = (r.values as RecordValue[] | undefined)?.[0]?.value ?? r.matchName;
      data = { clipKey: target.clipKey, effectMatchName: String(args.componentMatchName ?? r.matchName), parameterMatchName: String(args.expectedDisplayName ?? args.parameterIndex ?? "component"),
        valueEncoding: "native", requestedValue: (req.args.db ?? req.args.text ?? args.value ?? r.matchName) as Json,
        nativeValue: (args.value ?? r.matchName) as Json, readbackValue: readback as Json,
        keyframeTicks: Array.isArray(r.keyframeTicks) ? r.keyframeTicks.map(ticks => ({ ticks: String(ticks) })) : [] };
      if (req.operation === "pr.audio.gain" && audioContext) verification.push(observedGainEnvelope(req.args.keyframes as unknown as { ticks: string; db: number }[], audioContext.profile, audioContext.state, r));
      if (Array.isArray(args.parameterChanges)) {
        data.parameterMatchName = "semantic_parameters"; data.requestedValue = req.args.effect!;
        data.nativeValue = json({ parameters: args.parameterChanges }); data.readbackValue = json({ parameters: args.parameterChanges });
      }
    } else if (req.operation === "pr.frame.capture") {
      schema = "evidence.capture.v1";
      const png = await verifyPng(String(r.outputPath), Number(r.width), Number(r.height));
      const asset = await assets.registerGenerated(String(r.outputPath), { kind: "image", mimeType: "image/png", width: Number(r.width), height: Number(r.height) });
      const artifact: ArtifactReceipt = { kind: "artifact", asset, operationId: req.operationId, sourceAssets: protectedSources(req).map(a => a.assetId), recipeDigest: receipt.requestDigest, published: false, verification };
      artifacts.push(artifact); resources.artifact = single("artifact", "frame", artifact);
      const key = String(args.evidenceKey ?? req.stepKey);
      const snapshotDigest = digest(r);
      data = { evidenceKeys: [key], snapshotDigest, requestedTicks: { ticks: String(r.requestedTicks) }, resolvedTicks: { ticks: String(r.resolvedTicks) }, isProxy: r.isProxy === true };
      receipt.evidence.push({ kind: "frame", evidenceKey: key, operationId: req.operationId, sourceAssetIds: artifact.sourceAssets, snapshotDigest, capturedAt: new Date().toISOString(), artifact: asset,
        ...(req.target ? { target: req.target } : {}), sourceBounds: { x: 0, y: 0, width: Number(r.sourceWidth), height: Number(r.sourceHeight) }, width: Number(r.width), height: Number(r.height),
        color: { ...png, range: "full" }, evidenceToSource: [Number(r.sourceWidth) / Number(r.width), 0, 0, Number(r.sourceHeight) / Number(r.height), 0, 0],
        temporal: { requested: { ticks: String(r.requestedTicks) }, resolved: { ticks: String(r.resolvedTicks) }, sequenceGuid: String(r.sequenceGuid), isProxy: r.isProxy === true } });
    } else if (["pr.project.save", "pr.export"].includes(req.operation)) {
      schema = "export.completed.v1";
      const output = args.output as ArtifactSpec, outputPath = String(args.outputPath);
      const staged = await assets.registerGenerated(outputPath);
      if (req.operation === "pr.export") {
        if (!r.expectedDurationTicks || BigInt(String(r.expectedDurationTicks)) <= 0n) throw coded("OUTPUT_RANGE_UNOBSERVED", "The exact native export duration was not observed");
        const limits = record(args.executionResources);
        const checked = await context.worker!.run({ workerRequestId: req.operationId + ":verify", operation: "artifact.verify", inputs: { source: { path: outputPath, sha256: staged.sha256 } },
          options: { output, expectedDurationTicks: String(r.expectedDurationTicks), verifyMode: args.verifyMode ?? "metadata_and_changed_regions" }, outputDirectory: dirname(outputPath),
          limits: { maxCpuThreads: Number(limits.maxCpuThreads ?? 2), maxTemporaryBytes: String(limits.maxTemporaryBytes ?? (BigInt(staged.sizeBytes) + 1073741824n)), maxOutputBytes: 1048576,
            timeoutMs: Math.max(1000, Math.min(Number(limits.timeoutMs ?? 120000), Date.parse(req.executionDeadline) - Date.now())) } });
        if (!checked.ok || checked.data.verified !== true) throw coded("OUTPUT_VERIFICATION_FAILED", checked.error?.message ?? "Worker did not verify the actual output");
        const after = await hashFile(outputPath);
        if (after.sha256 !== staged.sha256 || after.sizeBytes !== staged.sizeBytes) throw Object.assign(coded("OUTPUT_CHANGED_DURING_VERIFICATION", "Export bytes changed while being verified"), { outcomeUnknown: true });
        verification.push({ assertionId: req.operationId + ":output", status: "pass", method: "Direct/event candidate plus exact range, required media metadata and decode checks; sha256/size unchanged before and after verification", actual: json(checked.data) });
        await native(req, "pr.export.finalize", { exportJobId: req.operationId, ...(req.target ? { target: req.target } : {}) }, mode);
      }
      const asset = await assets.publish(staged, output, protectedSources(req));
      const artifact: ArtifactReceipt = { kind: "artifact", asset, operationId: req.operationId, sourceAssets: protectedSources(req).map(a => a.assetId), recipeDigest: receipt.requestDigest, published: true, verification };
      if (args.resolvedEncoding) artifact.resolvedEncoding = args.resolvedEncoding as NonNullable<ArtifactReceipt["resolvedEncoding"]>;
      artifacts.push(artifact); resources.artifact = single("artifact", output.outputKey, artifact);
      data = { outputKeys: [output.outputKey], artifactIds: [asset.assetId], published: true, verificationScope: args.verifyMode === "full_decode" ? "full_decode" : "metadata_and_changed_regions",
        ...(r.hostJobId ? { completedHostJobId: String(r.hostJobId) } : {}) };
      if (req.operation === "pr.project.save") receipt.recovery.savedThroughOperationIds = [req.operationId];
    }
    const terminal = began ? await bridge.endOperation!(req.operationId, "SUCCEEDED") : "SUCCEEDED";
    if (receipt.dataState !== "unavailable") throw coded("RECEIPT_STATE_INVALID", "Only an unapplied domain result can be finalized");
    const { dataReason, ...completeBase } = receipt;
    const completed: OperationReceipt = { ...completeBase, status: terminal === "SUCCEEDED" ? "SUCCEEDED" : "OUTCOME_UNKNOWN", effect: mode === "mutate" ? "applied" : "not_applied",
      dataState: "complete", dataSchemaId: schema, data, resources, artifacts, verification, ...(targetAfter ? { targetAfter } : {}),
      recovery: { ...receipt.recovery, effectEvidence: "postcondition", afterDigest: digest(data) },
      cancelRequested: cancelled.has(req.operationId), timestamps: { ...receipt.timestamps, applied: new Date().toISOString(), finalized: new Date().toISOString() } };
    await persist(completed); return completed;
  }
  const adapter: MaterializingHostAdapter & { resolveHost(): Promise<HostRef> } = {
    resolveHost,
    async describeCapabilities(host): Promise<Capability[]> {
      const current = await resolveHost();
      if (digest(current) !== digest(host)) throw coded("STALE_HOST", "Capabilities requested for another host epoch");
      const profiles = (context.parameterProfiles ?? []).filter(p => p.hostVersion === hostVersion);
      const gainConfigured = (await audioProfiles()).some(p => p.route === "uxp" && p.hostVersion === hostVersion);
      return OPERATIONS.map(id => ({ id, contractVersion: "1.0", state: id === "pr.captions.import" || id === "pr.export" && !context.worker ||
        id === "pr.audio.gain" && !gainConfigured || id === "pr.effect.apply" && !profiles.some(p => p.semantic.startsWith("effect.")) ||
        id === "pr.motion.set" && !profiles.some(p => p.semantic.startsWith("motion.")) || id === "pr.title.setText" && !profiles.some(p => p.semantic === "title.text") ? "requires_setup" : "available",
        route: id === "pr.captions.import" ? "cep" : "uxp", hostVersion, preservesNativeEditing: true,
        ...(id === "pr.captions.import" ? { reason: "Native SRT placement exists; a qualified native cue/style readback provider is required for automatic success" } : {}) }));
    },
    prepare,
    dispatch(req) {
      const hash = requestDigest(req), running = active.get(req.operationId);
      if (running) return running.digest === hash ? running.promise : Promise.reject(coded("IDEMPOTENCY_CONFLICT", "Operation ID has different input"));
      const promise = run(req).finally(() => active.delete(req.operationId));
      active.set(req.operationId, { digest: hash, promise }); return promise;
    },
    getReceipt,
    async readPostcondition(req) {
      const result = await getReceipt(req.operationId);
      if (!result) return [{ assertionId: req.operationId, status: "not_run", method: "No native receipt exists; no replay was attempted" }];
      if (["pr.clip.move", "pr.clip.trim", "pr.timeline.edit", "pr.timeline.inspect"].includes(req.operation) && result.targetAfter?.kind === "pr_clip") {
        const state = await withRead("pr.timeline.inspect", { target: result.targetAfter });
        const target = result.targetAfter;
        const matches = (state.result.clips as RecordValue[]).filter(c => c.mediaType === target.mediaType && c.trackIndex === target.trackIndex && String(c.startTicks) === target.timelineRange.start.ticks && String(c.endTicks) === target.timelineRange.end.ticks && String(c.inTicks) === target.sourceRange.start.ticks && String(c.outTicks) === target.sourceRange.end.ticks);
        if (matches.length === 1 && typeof matches[0]!.mediaPath === "string") {
          const source = await assets.registerGenerated(String(matches[0]!.mediaPath));
          if (target.sourceAssetId.startsWith("sha256:") && source.assetId !== target.sourceAssetId) return [{ assertionId: req.operationId + ":fresh", status: "fail", method: "Fresh exact source byte identity changed" }];
        }
        return [{ assertionId: req.operationId + ":fresh", status: matches.length === 1 ? "pass" : "fail", method: "Fresh exact clip timeline/source readback" }];
      }
      return [{ assertionId: req.operationId, status: "not_run", method: "This operation requires its own fresh reconciliation projection; a saved receipt is not a new host observation" }];
    },
    async requestCancel(operationId) {
      cancelled.add(operationId);
      return { requested: true, stopped: !active.has(operationId) };
    },
  };
  return adapter;
}
