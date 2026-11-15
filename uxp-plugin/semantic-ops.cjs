"use strict";
// All create*Action calls stay inside lockedAccess/executeTransaction.
// Objects never cross the bridge: handles are bound to this panel epoch and a sequence.
const OPERATIONS = [
  "timeline.clip.find", "timeline.clip.move_track", "timeline.clip.duplicate", "timeline.clip.trim",
  "timeline.clip.remove", "timeline.clip.effect", "timeline.clip.parameter", "timeline.clip.add_transition",
  "pr.project.create", "pr.project.open", "pr.project.save", "pr.project.close_inactive",
  "pr.sequence.create", "pr.sequence.duplicate", "pr.timeline.inspect", "pr.media.import",
  "pr.media.relink", "pr.media.proxy", "pr.media.rename", "pr.media.label", "pr.media.offline",
  "pr.timeline.edit", "pr.clip.inspect", "pr.clip.qualify_time_map", "pr.clip.move", "pr.clip.trim", "pr.clip.remove", "pr.clip.replaceSource",
  "pr.effect.apply", "pr.parameter.set", "pr.audio.gain", "pr.title.setText", "pr.mogrt.insert",
  "pr.transcript.read", "pr.effects.inventory", "pr.effects.reset_keyframes",
  "pr.export.submit", "pr.export.status", "pr.export.cancel", "pr.export.finalize", "pr.frame.capture"
];
function createSemanticOperations(ppro, uxp, epoch) {
  const records = new Map(), exportJobs = new Map();
  const constantClips = new WeakSet();
  let nextId = 0, encoderListeners = false;
  const fail = (code, message, extra) => { throw Object.assign(new Error(message || code), { code }, extra || {}); };
  const string = (value, field) => {
    if (typeof value !== "string" || !value.trim()) fail("INVALID_ARGUMENT", field + " is required");
    return value.trim();
  };
  const tick = value => {
    const text = String(value && value.ticks !== undefined ? value.ticks : value);
    if (!/^-?\d+$/.test(text)) fail("INVALID_TIME", "Expected decimal ticks");
    return text;
  };
  const time = value => ppro.TickTime.createWithTicks(tick(value));
  const seconds = value => {
    if (!Number.isFinite(value)) fail("INVALID_TIME", "Expected finite seconds");
    return ppro.TickTime.createWithSeconds(value).ticks;
  };
  const pathKey = value => String(value || "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const guid = value => ppro.Guid.fromString(string(value, "GUID"));
  const identity = value => String(value && (value.guid || value.getId && value.getId()) || "");
  function transaction(project, title, actions) {
    let entered = false, accepted = false;
    try {
      project.lockedAccess(() => {
        accepted = project.executeTransaction(compound => {
          entered = true;
          actions(compound);
        }, title);
      });
      if (accepted !== true) fail("TRANSACTION_REJECTED", title + " was not accepted", { outcomeUnknown: entered, dispatchState: entered ? "dispatched_unverified" : "not_dispatched" });
    } catch (error) {
      if (entered && error.code !== "INVALID_ARGUMENT") { error.outcomeUnknown = true; error.dispatchState = "dispatched_unverified"; }
      throw error;
    }
  }
  const verified = (result, method) => ({ result, verification: { outcome: "verified", method } });
  const assertAfter = (condition, message) => {
    if (!condition) fail("POSTCONDITION_NOT_VERIFIED", message, { outcomeUnknown: true, dispatchState: "dispatched_unverified" });
  };
  async function context(args, requireSequence = false) {
    const target = args.target || {};
    const projectId = args.projectGuid || target.projectGuid;
    const project = projectId ? ppro.Project.getProject(guid(projectId)) : await ppro.Project.getActiveProject();
    if (!project || projectId && identity(project) !== String(projectId)) fail("TARGET_NOT_FOUND", "Project is not open");
    const sequenceId = args.sequenceGuid || target.sequenceGuid;
    let sequence = sequenceId ? await project.getSequence(guid(sequenceId)) : await project.getActiveSequence();
    if (args.binding) {
      const binding = args.binding;
      if (pathKey(project.path) !== pathKey(binding.projectPath)) fail("TARGET_PROJECT_MISMATCH");
      const candidates = Array.from(await project.getSequences()).filter(s => String(s.name) === binding.sequenceName);
      if (candidates.length !== 1) fail("SEQUENCE_BINDING_NOT_UNIQUE", "CEP/UXP sequence binding needs a unique exact sequence identity");
      sequence = candidates[0];
    }
    if (requireSequence && !sequence) fail("TARGET_NOT_FOUND", "Sequence is not open");
    if (sequenceId && identity(sequence) !== String(sequenceId)) fail("TARGET_SEQUENCE_MISMATCH");
    return { project, sequence };
  }
  async function projectItems(project) {
    const result = [];
    async function visit(folder) {
      for (const item of await folder.getItems()) {
        result.push(item);
        if (typeof item.getItems === "function") await visit(item);
      }
    }
    await visit(await project.getRootItem());
    return result;
  }
  async function itemById(project, id) {
    const found = (await projectItems(project)).filter(item => identity(item) === String(id));
    if (found.length !== 1) fail(found.length ? "TARGET_NOT_UNIQUE" : "TARGET_NOT_FOUND", "Project item " + id);
    return ppro.ClipProjectItem.cast(found[0]) || found[0];
  }
  async function snapshot(item, mediaType, trackIndex) {
    const source = await item.getProjectItem();
    const clipSource = ppro.ClipProjectItem.cast(source);
    return {
      name: String(await item.getName()), projectItemId: identity(source),
      mediaPath: clipSource ? String(await clipSource.getMediaFilePath()) : "",
      mediaType, trackIndex,
      startTicks: tick(await item.getStartTime()), endTicks: tick(await item.getEndTime()),
      inTicks: tick(await item.getInPoint()), outTicks: tick(await item.getOutPoint()),
      speed: Number(await item.getSpeed()), reverse: Boolean(await item.isSpeedReversed()),
      disabled: Boolean(await item.isDisabled()),
      editableState: await editableSnapshot(item)
    };
  }
  function issue(item, project, sequence, data) {
    const id = epoch + "-semantic-" + (++nextId);
    // Keep the issued observation owner-owned. Returned result objects and later
    // successful edits must never mutate an older handle's baseline in place.
    const record = { item, projectGuid: identity(project), sequenceGuid: identity(sequence), data: JSON.parse(JSON.stringify(data)), constantTimeMap: constantClips.has(item), expires: Date.now() + 1800000 };
    records.set(id, record);
    if (records.size > 8192) {
      for (const [key, value] of records) if (value.expires < Date.now()) records.delete(key);
      if (records.size > 8192) fail("HANDLE_LIMIT", "Release or refresh target handles");
    }
    return { $ref: id, session: epoch, projectGuid: record.projectGuid, sequenceGuid: record.sequenceGuid, mediaType: data.mediaType, state: JSON.stringify(data) };
  }
  async function enumerate(sequence, mediaType, trackIndex) {
    if (!["video", "audio"].includes(mediaType)) fail("INVALID_MEDIA_TYPE");
    const count = await sequence[mediaType === "video" ? "getVideoTrackCount" : "getAudioTrackCount"]();
    if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= count) fail("TARGET_TRACK_NOT_FOUND");
    const track = await sequence[mediaType === "video" ? "getVideoTrack" : "getAudioTrack"](trackIndex);
    return Array.from(await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false));
  }
  function sameSourceState(actual, expected) {
    return ["startTicks", "endTicks", "inTicks", "outTicks"].every(key => expected[key] === undefined || actual[key] === String(expected[key])) &&
      (expected.mediaPath === undefined || pathKey(actual.mediaPath) === pathKey(expected.mediaPath)) &&
      (expected.projectItemId === undefined || actual.projectItemId === expected.projectItemId);
  }
  async function find(args, ctx) {
    const binding = args.binding || args.target || {};
    const mediaType = binding.mediaType || args.mediaType || args.target && args.target.mediaType;
    const trackIndex = binding.trackIndex === undefined ? args.trackIndex : binding.trackIndex;
    const items = await enumerate(ctx.sequence, mediaType, trackIndex);
    let candidates = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index], state = await snapshot(item, mediaType, trackIndex);
      let matches = false;
      if (Object.keys(binding).length && (binding.startTicks !== undefined || binding.timelineRange)) {
        const expected = binding.timelineRange ? { startTicks: binding.timelineRange.start.ticks, endTicks: binding.timelineRange.end.ticks, inTicks: binding.sourceRange.start.ticks, outTicks: binding.sourceRange.end.ticks } : binding;
        matches = sameSourceState(state, expected);
      } else if (Number.isInteger(args.clipIndex)) matches = index === args.clipIndex;
      else if (args.clipTimeSeconds !== undefined) {
        const position = BigInt(seconds(args.clipTimeSeconds));
        matches = position >= BigInt(state.startTicks) && position < BigInt(state.endTicks);
      } else if (typeof args.clipName === "string" && args.clipName.trim()) matches = state.name === args.clipName;
      if (matches) candidates.push({ item, state, index });
    }
    if (candidates.length !== 1) fail(candidates.length ? "TARGET_NOT_UNIQUE" : "TARGET_NOT_FOUND", "Clip locator must resolve exactly one item");
    const match = candidates[0];
    return { item: match.item, data: match.state, handle: issue(match.item, ctx.project, ctx.sequence, match.state), clipIndex: match.index, countOnTrack: items.length };
  }
  async function resolve(args, ctx) {
    const ref = args.trackItem || args.clip || (args.target && args.target.uxpHandleId ? { $ref: args.target.uxpHandleId, session: args.target.host && args.target.host.hostEpoch } : null);
    if (!ref) return find(args, ctx);
    const record = records.get(ref.$ref);
    if (!record || ref.session !== epoch || record.expires < Date.now()) fail("STALE_TARGET", "Clip handle is from another host epoch or expired");
    if (record.projectGuid !== identity(ctx.project) || record.sequenceGuid !== identity(ctx.sequence)) fail("TARGET_SEQUENCE_MISMATCH");
    const items = await enumerate(ctx.sequence, record.data.mediaType, record.data.trackIndex);
    if (!items.includes(record.item)) {
      // Host wrappers may be recreated: compare immutable source/range, and reject ambiguity.
      const matching = [];
      for (const item of items) if (sameSourceState(await snapshot(item, record.data.mediaType, record.data.trackIndex), record.data)) matching.push(item);
      if (matching.length !== 1) fail("STALE_TARGET", "Clip membership changed");
      record.item = matching[0];
      if (record.constantTimeMap) constantClips.add(record.item);
    }
    const data = await snapshot(record.item, record.data.mediaType, record.data.trackIndex);
    if (JSON.stringify(data) !== JSON.stringify(record.data)) fail("STALE_TARGET", "Clip changed after preparation");
    return { item: record.item, data, handle: ref, countOnTrack: items.length };
  }
  async function resultFor(item, ctx, before, extra) {
    const after = await snapshot(item, before.mediaType, await item.getTrackIndex());
    return { before, after, handle: issue(item, ctx.project, ctx.sequence, after), ...extra };
  }
  async function componentList(item) {
    const chain = await item.getComponentChain(), result = [];
    for (let i = 0; i < chain.getComponentCount(); i++) {
      const component = chain.getComponentAtIndex(i);
      result.push({ index: i, component, matchName: String(await component.getMatchName()), displayName: String(await component.getDisplayName()) });
    }
    return { chain, components: result };
  }
  async function componentParameter(item, args) {
    const list = await componentList(item);
    const found = list.components.filter(c => c.matchName === args.componentMatchName && (args.componentIndex === undefined || c.index === args.componentIndex));
    if (found.length !== 1) fail(found.length ? "COMPONENT_AMBIGUOUS" : "COMPONENT_NOT_FOUND");
    const component = found[0].component;
    if (!Number.isInteger(args.parameterIndex) || args.parameterIndex < 0 || args.parameterIndex >= component.getParamCount()) fail("PARAMETER_NOT_FOUND");
    const parameter = component.getParam(args.parameterIndex);
    if (args.expectedDisplayName && parameter.displayName !== args.expectedDisplayName) fail("PARAMETER_IDENTITY_MISMATCH");
    return { parameter, component: found[0] };
  }
  function editableValue(value) {
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value && ["red", "green", "blue", "alpha"].every(key => typeof value[key] === "number" && Number.isFinite(value[key]))) return { red: value.red, green: value.green, blue: value.blue, alpha: value.alpha };
    if (value && typeof value.x === "number" && Number.isFinite(value.x) && typeof value.y === "number" && Number.isFinite(value.y)) return { x: value.x, y: value.y };
    fail("PARAMETER_VALUE_UNOBSERVED", "Native parameter value is not a supported finite scalar, PointF or Color");
  }
  async function parameterSnapshot(parameter, index) {
    const observed = { index, status: "unavailable" };
    try {
      if (typeof parameter.displayName !== "string") fail("PARAMETER_IDENTITY_UNOBSERVED");
      observed.displayName = parameter.displayName;
      observed.startValue = editableValue((await parameter.getStartValue()).value.value);
      const varying = parameter.isTimeVarying();
      if (typeof varying !== "boolean") fail("PARAMETER_ANIMATION_UNOBSERVED");
      observed.timeVarying = varying;
      const nativeKeys = parameter.getKeyframeListAsTickTimes();
      if (!Array.isArray(nativeKeys)) fail("PARAMETER_KEY_INVENTORY_UNOBSERVED");
      const keys = nativeKeys.map(value => String(BigInt(tick(value)))).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
      if (new Set(keys).size !== keys.length) fail("PARAMETER_KEY_INVENTORY_UNOBSERVED");
      observed.keys = [];
      let complete = !varying || keys.length > 0;
      const modes = ppro.Constants && ppro.Constants.InterpolationMode || {};
      const simpleModes = [modes.LINEAR, modes.HOLD, ppro.Keyframe && ppro.Keyframe.INTERPOLATION_MODE_LINEAR, ppro.Keyframe && ppro.Keyframe.INTERPOLATION_MODE_HOLD].filter(value => typeof value === "number");
      for (const at of keys) {
        const key = { ticks: at, value: editableValue(await parameter.getValueAtTime(time(at))) };
        if (typeof parameter.getKeyframePtr === "function") {
          const nativeKey = parameter.getKeyframePtr(time(at));
          if (nativeKey && typeof nativeKey.getTemporalInterpolationMode === "function") {
            const mode = await nativeKey.getTemporalInterpolationMode();
            if (typeof mode === "number" && Number.isFinite(mode)) key.temporalInterpolationMode = mode;
          }
        }
        // The public type has no Bezier tangent/control-point reader. Equal
        // knots/modes cannot prove an unchanged Bezier curve; do not overwrite it.
        if (!simpleModes.includes(key.temporalInterpolationMode)) complete = false;
        observed.keys.push(key);
      }
      observed.status = complete ? "complete" : "unavailable";
      if (!complete) observed.reasonCode = "PARAMETER_CURVE_UNOBSERVED";
    } catch (error) {
      observed.reasonCode = error && typeof error.code === "string" ? error.code : "PARAMETER_STATE_UNOBSERVED";
    }
    return observed;
  }
  async function editableSnapshot(item) {
    try {
      const list = await componentList(item), components = [];
      const count = list.chain.getComponentCount();
      if (!Number.isInteger(count) || count < 0 || count !== list.components.length) fail("COMPONENT_INVENTORY_UNOBSERVED");
      for (const entry of list.components) {
        const count = entry.component.getParamCount(), parameters = [];
        if (!entry.matchName || !Number.isInteger(count) || count < 0) fail("COMPONENT_INVENTORY_UNOBSERVED");
        for (let index = 0; index < count; index++) parameters.push(await parameterSnapshot(entry.component.getParam(index), index));
        components.push({ index: entry.index, matchName: entry.matchName, displayName: entry.displayName, parameters });
      }
      return { status: components.every(component => component.parameters.every(parameter => parameter.status === "complete")) ? "complete" : "partial", components };
    } catch (error) {
      return { status: "unavailable", reasonCode: error && typeof error.code === "string" ? error.code : "COMPONENT_STATE_UNOBSERVED" };
    }
  }
  async function assertEditableBaseline(item, before, selection) {
    const actual = await editableSnapshot(item), expected = before.editableState;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("STALE_TARGET", "Editable component or parameter state changed after preparation");
    if (!expected || !Array.isArray(expected.components)) fail("EDITABLE_STATE_UNAVAILABLE", "Native component membership could not be observed");
    if (selection) {
      const matches = expected.components.filter(component => component.index === selection.componentIndex && component.matchName === selection.componentMatchName);
      if (matches.length !== 1) fail("EDITABLE_STATE_UNAVAILABLE", "Exact native component baseline is unavailable");
      const parameters = selection.parameterIndex === undefined ? matches[0].parameters : matches[0].parameters.filter(parameter => parameter.index === selection.parameterIndex);
      if (selection.parameterIndex !== undefined && parameters.length !== 1 || parameters.some(parameter => parameter.status !== "complete")) fail("EDITABLE_STATE_UNAVAILABLE", "The parameter being overwritten has an unobserved native value or animation curve");
    }
  }
  async function execute(operation, args = {}) {
    if (args.expectedHostEpoch !== undefined && args.expectedHostEpoch !== epoch) fail("STALE_HOST", "The host restarted after operation preparation");
    if (operation === "pr.project.create" || operation === "pr.project.open") {
      const path = string(args.path, "path");
      let project = operation === "pr.project.create" ? await ppro.Project.createProject(path) : await ppro.Project.open(path);
      if (!project || pathKey(project.path) !== pathKey(path)) fail("PROJECT_OPEN_NOT_VERIFIED", path, { outcomeUnknown: true });
      if (args.saveAsPath) {
        if (!await project.saveAs(string(args.saveAsPath, "saveAsPath"))) fail("PROJECT_SAVE_FAILED", "Working copy save failed", { outcomeUnknown: true });
        assertAfter(pathKey(project.path) === pathKey(args.saveAsPath), "Working project path mismatch");
      }
      return verified({ projectGuid: identity(project), path: String(project.path), name: String(project.name) }, "exact project path and GUID");
    }
    if (operation === "pr.export.status" || operation === "pr.export.cancel") {
      const job = exportJobs.get(string(args.exportJobId, "exportJobId"));
      if (!job) fail("EXPORT_JOB_NOT_FOUND");
      if (operation === "pr.export.cancel") fail("EXPORT_CANCEL_API_UNAVAILABLE", "This Premiere encoder API exposes cancel events but no cancellation command; the active job remains tracked");
      return verified({ ...job }, "Observed export dispatch/event state; output completion is independently verified by the authority");
    }
    const ctx = await context(args, operation.startsWith("timeline.") || operation.startsWith("pr.clip.") || ["pr.timeline.edit", "pr.mogrt.insert", "pr.frame.capture", "pr.export.submit"].includes(operation) || operation === "pr.timeline.inspect" && !(args.target && args.target.kind === "pr_project"));
    if (operation === "pr.project.save") {
      const accepted = args.path ? await ctx.project.saveAs(string(args.path, "path")) : await ctx.project.save();
      assertAfter(accepted === true && (!args.path || pathKey(ctx.project.path) === pathKey(args.path)), "Project save failed");
      return verified({ projectGuid: identity(ctx.project), path: String(ctx.project.path), saved: true }, "Project save boolean and path");
    }
    if (operation === "pr.project.close_inactive") {
      if (typeof args.expectedHostEpoch !== "string" || !args.expectedHostEpoch) fail("HOST_EPOCH_REQUIRED");
      if (!args.projectGuid && !(args.target && args.target.projectGuid)) fail("PROJECT_TARGET_REQUIRED");
      const active = await ppro.Project.getActiveProject();
      if (identity(active) === identity(ctx.project)) fail("TARGET_NOT_INACTIVE");
      if (!["save", "discard"].includes(args.savePolicy)) fail("SAVE_POLICY_REQUIRED");
      if (args.savePolicy === "save") assertAfter(await ctx.project.save() === true, "Inactive project save failed");
      const targetId = identity(ctx.project), activeId = identity(active);
      const options = new ppro.CloseProjectOptions().setPromptIfDirty(false).setSaveWorkspace(false);
      const ok = await ctx.project.close(options);
      assertAfter(ok === true && identity(await ppro.Project.getActiveProject()) === activeId, "Inactive close altered the active project");
      let remains = null; try { remains = ppro.Project.getProject(guid(targetId)); } catch (_) { remains = null; }
      assertAfter(!remains, "Target project remains open");
      return verified({ closedProjectGuid: targetId, preservedActiveProjectGuid: activeId, closed: true }, "Exact inactive project GUID absence and active GUID preservation");
    }
    if (operation === "pr.sequence.create") {
      const name = string(args.name, "name"), presetPath = string(args.presetPath, "presetPath");
      const sequence = await ctx.project.createSequenceWithPresetPath(name, presetPath);
      assertAfter(sequence && (await ctx.project.getSequences()).some(s => identity(s) === identity(sequence)), "Sequence creation readback failed");
      const frameSize = await sequence.getFrameSize(), timebase = String(await sequence.getTimebase());
      const rate = args.frameRate;
      assertAfter((args.width === undefined || frameSize.width === args.width) && (args.height === undefined || frameSize.height === args.height) &&
        (!rate || BigInt(timebase) * BigInt(rate.num) === 254016000000n * BigInt(rate.den)), "Sequence preset does not match the requested width, height or rational frame rate");
      return verified({ projectGuid: identity(ctx.project), sequenceGuid: identity(sequence), name: String(sequence.name), timebase, frameSize }, "Created sequence GUID and exact requested settings readback");
    }
    if (operation === "pr.media.import") {
      const items = args.items;
      if (!Array.isArray(items) || !items.length || items.length > 128) fail("INVALID_ARGUMENT", "1..128 items required");
      const keys = new Set(), before = new Set((await projectItems(ctx.project)).map(identity));
      for (const entry of items) { string(entry.itemKey, "itemKey"); string(entry.path, "path"); if (keys.has(entry.itemKey)) fail("DUPLICATE_ITEM_KEY"); keys.add(entry.itemKey); }
      assertAfter(await ctx.project.importFiles(items.map(i => i.path), true, await ctx.project.getRootItem(), false) === true, "Media import failed");
      const all = await projectItems(ctx.project), output = [];
      for (const entry of items) {
        const matches = [];
        for (const item of all) {
          const clip = ppro.ClipProjectItem.cast(item);
          if (clip && pathKey(await clip.getMediaFilePath()) === pathKey(entry.path)) matches.push(item);
        }
        const added = matches.filter(i => !before.has(identity(i)));
        const chosen = added.length === 1 ? added[0] : matches.length === 1 ? matches[0] : null;
        assertAfter(!!chosen, "Imported media cannot be identified uniquely: " + entry.itemKey);
        output.push({ itemKey: entry.itemKey, projectItemId: identity(chosen), mediaPath: entry.path, projectGuid: identity(ctx.project) });
      }
      return verified({ items: output }, "Imported project item IDs and exact source paths");
    }
    if (["pr.media.relink", "pr.media.proxy", "pr.media.rename", "pr.media.label", "pr.media.offline", "pr.transcript.read"].includes(operation)) {
      const item = await itemById(ctx.project, args.projectItemId || args.target && args.target.projectItemId);
      if (operation === "pr.transcript.read") {
        if (!ppro.Transcript.hasTranscript(item)) fail("TRANSCRIPT_NOT_AVAILABLE");
        return verified({ transcript: JSON.parse(await ppro.Transcript.exportToJSON(item)) }, "Native source transcript JSON");
      }
      if (operation === "pr.media.relink") {
        const path = string(args.path, "path");
        if (!await item.canChangeMediaPath()) fail("MEDIA_RELINK_UNAVAILABLE");
        assertAfter(await item.changeMediaFilePath(path, false) === true && pathKey(await item.getMediaFilePath()) === pathKey(path), "Relink readback failed");
      } else if (operation === "pr.media.proxy") {
        if (!await item.canProxy()) fail("PROXY_NOT_SUPPORTED_FOR_MEDIA");
        const path = string(args.path, "proxyPath");
        assertAfter(await item.attachProxy(path, false) === true && await item.hasProxy() && pathKey(await item.getProxyPath()) === pathKey(path), "Proxy attachment readback failed");
      } else {
        transaction(ctx.project, operation, c => c.addAction(operation === "pr.media.rename" ? item.createSetNameAction(string(args.name, "name")) : operation === "pr.media.label" ? item.createSetColorLabelAction(args.label) : item.createSetOfflineAction()));
        if (operation === "pr.media.rename") assertAfter(String(item.name) === args.name, "Rename readback failed");
        if (operation === "pr.media.label") assertAfter(await item.getColorLabelIndex() === args.label, "Label readback failed");
        if (operation === "pr.media.offline") assertAfter(await item.isOffline(), "Offline readback failed");
      }
      return verified({ projectItemId: identity(item), mediaPath: String(await item.getMediaFilePath()), proxyPath: await item.hasProxy() ? String(await item.getProxyPath()) : null }, "Target project item property readback");
    }
    if (operation === "pr.timeline.inspect") {
      const clips = [], sequences = [], tracks = [];
      const selectedSequences = args.target && args.target.kind === "pr_project" ? Array.from(await ctx.project.getSequences()) : [ctx.sequence];
      for (const sequence of selectedSequences) {
        const sequenceGuid = identity(sequence);
        sequences.push({ sequenceGuid, name: String(sequence.name), timebase: String(await sequence.getTimebase()), endTicks: tick(await sequence.getEndTime()), frameSize: await sequence.getFrameSize() });
        for (const mediaType of ["video", "audio"]) {
          const count = await sequence[mediaType === "video" ? "getVideoTrackCount" : "getAudioTrackCount"]();
          for (let t = 0; t < count; t++) {
            const items = await enumerate(sequence, mediaType, t);
            tracks.push({ sequenceGuid, mediaType, trackIndex: t, clipCount: items.length });
            for (const item of items) {
              const data = await snapshot(item, mediaType, t);
              clips.push({ ...data, sequenceGuid, handle: issue(item, ctx.project, sequence, data) });
            }
          }
        }
      }
      const mediaItems = [];
      for (const projectItem of await projectItems(ctx.project)) {
        const media = ppro.ClipProjectItem.cast(projectItem);
        if (!media) continue;
        const mediaPath = String(await media.getMediaFilePath());
        if (mediaPath) mediaItems.push({ projectItemId: identity(projectItem), name: String(projectItem.name), mediaPath });
      }
      return verified({ projectGuid: identity(ctx.project), sequences, tracks, clips, mediaItems }, "Actual project/sequence clip, source, track and tick inventory");
    }
    if (operation === "timeline.clip.find") {
      const found = await find(args, ctx);
      return verified({ handle: found.handle, ...found.data, clipIndex: found.clipIndex, countOnTrack: found.countOnTrack }, "Exact source/range/sequence target readback");
    }
    if (operation === "pr.sequence.duplicate") {
      if (!ctx.sequence) fail("TARGET_NOT_FOUND");
      const prior = new Set((await ctx.project.getSequences()).map(identity));
      transaction(ctx.project, "Duplicate sequence", c => c.addAction(ctx.sequence.createCloneAction()));
      const added = (await ctx.project.getSequences()).filter(s => !prior.has(identity(s)));
      assertAfter(added.length === 1, "Duplicate sequence GUID is not unique");
      return verified({ sequenceGuid: identity(added[0]), projectGuid: identity(ctx.project), name: String(added[0].name) }, "New sequence GUID");
    }
    if (operation === "pr.timeline.edit") return editSegments(args, ctx);
    if (operation === "pr.mogrt.insert") {
      const editor = ppro.SequenceEditor.getEditor(ctx.sequence);
      const items = editor.insertMogrtFromPath(string(args.path, "path"), time(args.timelineStartTicks), args.videoTrackIndex, args.audioTrackIndex);
      assertAfter(Array.isArray(items) && items.length > 0, "MOGRT insertion returned no clips");
      const clips = [];
      for (const item of items) {
        const mediaType = typeof item.createAddVideoTransitionAction === "function" ? "video" : "audio";
        const data = await snapshot(item, mediaType, await item.getTrackIndex());
        clips.push({ ...data, handle: issue(item, ctx.project, ctx.sequence, data) });
      }
      return verified({ clips }, "Inserted native MOGRT track items");
    }
    if (operation === "pr.export.submit") return submitExport(args, ctx);
    if (operation === "pr.export.finalize") {
      const job = exportJobs.get(string(args.exportJobId, "exportJobId"));
      if (!job) fail("EXPORT_JOB_NOT_FOUND");
      if (job.originalRange) {
        const sequence = await ctx.project.getSequence(guid(job.sequenceGuid));
        transaction(ctx.project, "Restore export range", c => {
          c.addAction(sequence.createSetInPointAction(time(job.originalRange.startTicks)));
          c.addAction(sequence.createSetOutPointAction(time(job.originalRange.endTicks)));
        });
        assertAfter(tick(await sequence.getInPoint()) === job.originalRange.startTicks && tick(await sequence.getOutPoint()) === job.originalRange.endTicks, "Export range restoration failed");
      }
      return verified({ restoredRange: !!job.originalRange }, "Original sequence in/out readback");
    }
    if (operation === "pr.frame.capture") {
      const output = string(args.outputPath, "outputPath"), slash = Math.max(output.lastIndexOf("/"), output.lastIndexOf("\\"));
      if (slash < 0) fail("OUTPUT_PATH_REQUIRED");
      const frame = await ctx.sequence.getFrameSize(), requested = BigInt(tick(args.ticks)), timebase = BigInt(String(await ctx.sequence.getTimebase()));
      if (requested < 0n || requested >= BigInt(tick(await ctx.sequence.getEndTime())) || timebase <= 0n) fail("FRAME_OUT_OF_RANGE");
      const position = time(requested / timebase * timebase), scale = args.maxEdge === undefined ? 1 : Math.min(1, Number(args.maxEdge) / Math.max(frame.width, frame.height));
      const width = Math.max(1, Math.round(frame.width * scale)), height = Math.max(1, Math.round(frame.height * scale));
      assertAfter(await ppro.Exporter.exportSequenceFrame(ctx.sequence, position, output.slice(slash + 1), output.slice(0, slash), width, height) === true, "Frame exporter rejected the requested frame");
      return verified({ outputPath: output, requestedTicks: tick(args.ticks), resolvedTicks: tick(position), sequenceGuid: identity(ctx.sequence), width, height, sourceWidth: frame.width, sourceHeight: frame.height, isProxy: args.isProxy === true }, "Exporter completed for the containing frame on the exact sequence grid; file content checked by authority");
    }
    const target = await resolve(args, ctx), item = target.item, before = target.data;
    if (operation === "pr.clip.inspect") return verified({ ...before, handle: target.handle, timeMapKind: constantClips.has(item) ? "constant_speed" : "unqualified" }, "Fresh bound clip state and owned/probed time-map provenance");
    if (operation === "pr.clip.qualify_time_map") {
      const { parameter } = await componentParameter(item, args);
      if (parameter.isTimeVarying() || parameter.getKeyframeListAsTickTimes().length !== 0) fail("VARIABLE_TIME_MAP_UNSUPPORTED", "The qualified intrinsic retime parameter has a variable curve");
      constantClips.add(item);
      const registered = records.get(target.handle.$ref); if (registered) registered.constantTimeMap = true;
      return verified({ timeMapKind: "constant_speed", componentMatchName: args.componentMatchName, parameterIndex: args.parameterIndex }, "Qualified intrinsic retime parameter is static and has no keyframes");
    }
    if (operation === "timeline.clip.move_track" || operation === "pr.clip.move") {
      if (args.collision && args.collision !== "reject") fail("MOVE_COLLISION_MODE_UNAVAILABLE", "Exact native move currently requires collision=reject");
      if (args.linkedPolicy === "preserve" && !Array.isArray(args.linkedItems)) fail("LINK_MEMBERSHIP_UNAVAILABLE");
      const targetTrack = args.targetTrackIndex === undefined ? before.trackIndex : args.targetTrackIndex;
      if (targetTrack !== before.trackIndex) fail("EXACT_CROSS_TRACK_MOVE_UNAVAILABLE", "The public clone API is not an exact move preserving native links; use explicit duplicate or same-track move");
      const destination = args.timelineStartTicks !== undefined ? tick(args.timelineStartTicks) : args.timelineStartSeconds !== undefined ? seconds(args.timelineStartSeconds) : (BigInt(before.startTicks) + BigInt(args.timeOffsetTicks || seconds(args.timeOffsetSeconds || 0))).toString();
      const delta = BigInt(destination) - BigInt(before.startTicks), linked = [];
      if (BigInt(destination) < 0n) fail("INVALID_TIME", "Move destination must be nonnegative");
      for (const binding of args.linkedItems || []) {
        if (binding.mediaType === before.mediaType && binding.trackIndex === before.trackIndex && binding.startTicks === before.startTicks && binding.inTicks === before.inTicks) continue;
        linked.push(await find({ binding }, ctx));
      }
      const moved = [target, ...linked];
      for (const moving of moved) {
        const start = BigInt(moving.data.startTicks) + delta, end = BigInt(moving.data.endTicks) + delta;
        if (start < 0n) fail("INVALID_TIME", "A linked clip would start before the sequence");
        for (const candidate of await enumerate(ctx.sequence, moving.data.mediaType, moving.data.trackIndex)) {
          const data = await snapshot(candidate, moving.data.mediaType, moving.data.trackIndex);
          if (moved.some(selected => selected.data.mediaType === data.mediaType && selected.data.trackIndex === data.trackIndex && sameSourceState(data, selected.data))) continue;
          if (start < BigInt(data.endTicks) && end > BigInt(data.startTicks)) fail("MOVE_COLLISION", "Move overlaps another clip on the exact target track");
        }
      }
      transaction(ctx.project, "Move clip", c => {
        c.addAction(item.createMoveAction(time(delta)));
        for (const link of linked) c.addAction(link.item.createMoveAction(time(delta)));
      });
      const result = await resultFor(item, ctx, before, { moved: true });
      assertAfter(result.after.startTicks === destination && BigInt(result.after.endTicks) - BigInt(result.after.startTicks) === BigInt(before.endTicks) - BigInt(before.startTicks), "Move did not reach absolute destination");
      assertAfter((await enumerate(ctx.sequence, before.mediaType, before.trackIndex)).length === target.countOnTrack, "Move changed clip count");
      result.linkedAfter = [];
      for (const link of linked) {
        const after = await snapshot(link.item, link.data.mediaType, link.data.trackIndex);
        assertAfter(BigInt(after.startTicks) === BigInt(link.data.startTicks) + delta && BigInt(after.endTicks) === BigInt(link.data.endTicks) + delta && after.inTicks === link.data.inTicks && after.outTicks === link.data.outTicks, "Linked item did not move with clip");
        result.linkedAfter.push({ ...after, handle: issue(link.item, ctx.project, ctx.sequence, after) });
      }
      result.linkedBefore = linked.map(link => link.data);
      return verified(result, "Absolute destination, unchanged source/count and linked-item readback");
    }
    if (operation === "timeline.clip.duplicate") {
      const editor = ppro.SequenceEditor.getEditor(ctx.sequence), destTrack = args.targetTrackIndex === undefined ? before.trackIndex : args.targetTrackIndex;
      const prior = await enumerate(ctx.sequence, before.mediaType, destTrack);
      const delta = BigInt(tick(args.timelineStartTicks)) - BigInt(before.startTicks), vertical = destTrack - before.trackIndex;
      transaction(ctx.project, "Duplicate clip", c => c.addAction(editor.createCloneTrackItemAction(item, time(delta), before.mediaType === "video" ? vertical : 0, before.mediaType === "audio" ? vertical : 0, false, args.isInsert === true)));
      const afterItems = await enumerate(ctx.sequence, before.mediaType, destTrack);
      assertAfter(afterItems.length === prior.length + 1, "Duplicate did not add exactly one target item");
      return verified({ duplicated: true, original: before, destinationTrackIndex: destTrack, timelineStartTicks: tick(args.timelineStartTicks) }, "Destination clip count and explicit duplicate semantics");
    }
    if (operation === "timeline.clip.trim" || operation === "pr.clip.trim") {
      if (!constantClips.has(item)) {
        if (!args.timeMapProfile) fail("TIME_MAP_UNQUALIFIED", "Existing clips need an intrinsic retime parameter profile; source/timeline duration ratio alone does not prove constant speed");
        const { parameter } = await componentParameter(item, args.timeMapProfile);
        if (parameter.isTimeVarying() || parameter.getKeyframeListAsTickTimes().length !== 0) fail("VARIABLE_TIME_MAP_UNSUPPORTED");
        constantClips.add(item);
      }
      if (args.linkedPolicy === "preserve" && !Array.isArray(args.linkedItems)) fail("LINK_MEMBERSHIP_UNAVAILABLE");
      const sourceIn = args.sourceInTicks !== undefined ? tick(args.sourceInTicks) : args.sourceInSeconds !== undefined ? seconds(args.sourceInSeconds) : before.inTicks;
      const sourceOut = args.sourceOutTicks !== undefined ? tick(args.sourceOutTicks) : args.sourceOutSeconds !== undefined ? seconds(args.sourceOutSeconds) : before.outTicks;
      if (BigInt(sourceIn) < 0n || BigInt(sourceOut) <= BigInt(sourceIn)) fail("INVALID_SOURCE_RANGE");
      if (!Number.isFinite(before.speed) || before.speed === 0) fail("SPEED_MAPPING_UNAVAILABLE");
      // Preserve the observed exact source/timeline ratio, including constant-speed reverse.
      const sourceDuration = BigInt(before.outTicks) - BigInt(before.inTicks), timelineDuration = BigInt(before.endTicks) - BigInt(before.startTicks);
      if (sourceDuration <= 0n || timelineDuration <= 0n) fail("SPEED_MAPPING_UNAVAILABLE");
      const numerator = (BigInt(sourceOut) - BigInt(sourceIn)) * timelineDuration;
      if (numerator % sourceDuration !== 0n) fail("TRIM_NOT_TICK_ALIGNED", "Source trim cannot be represented exactly on this clip time map");
      const duration = numerator / sourceDuration;
      const end = args.anchor === "sequence-end" ? BigInt(before.endTicks) : BigInt(before.startTicks) + duration;
      const start = end - duration;
      const linked = [];
      for (const binding of args.linkedItems || []) {
        if (binding.mediaType === before.mediaType && binding.trackIndex === before.trackIndex && binding.startTicks === before.startTicks && binding.inTicks === before.inTicks) continue;
        const link = await find({ binding }, ctx), b = link.data;
        if (!constantClips.has(link.item)) {
          if (!args.linkTimeMapProfile) fail("LINK_TIME_MAP_UNQUALIFIED", "Linked clip needs its own qualified retime profile");
          const { parameter } = await componentParameter(link.item, args.linkTimeMapProfile);
          if (parameter.isTimeVarying() || parameter.getKeyframeListAsTickTimes().length !== 0) fail("VARIABLE_TIME_MAP_UNSUPPORTED");
          constantClips.add(link.item);
        }
        const ls = BigInt(b.outTicks) - BigInt(b.inTicks), lt = BigInt(b.endTicks) - BigInt(b.startTicks);
        const divisor = sourceDuration * lt;
        if (divisor <= 0n) fail("LINK_TIME_MAPPING_UNAVAILABLE");
        let di = BigInt(sourceIn) - BigInt(before.inTicks), dout = BigInt(sourceOut) - BigInt(before.outTicks);
        if (before.reverse !== b.reverse) { const priorDi = di; di = -dout; dout = -priorDi; }
        const ni = di * timelineDuration * ls, no = dout * timelineDuration * ls;
        if (ni % divisor || no % divisor) fail("LINK_TRIM_NOT_TICK_ALIGNED");
        linked.push({ ...link, inTicks: (BigInt(b.inTicks) + ni / divisor).toString(), outTicks: (BigInt(b.outTicks) + no / divisor).toString(),
          startTicks: (BigInt(b.startTicks) + start - BigInt(before.startTicks)).toString(), endTicks: (BigInt(b.endTicks) + end - BigInt(before.endTicks)).toString() });
      }
      transaction(ctx.project, "Trim source range", c => {
        c.addAction(item.createSetInPointAction(time(sourceIn)));
        c.addAction(item.createSetOutPointAction(time(sourceOut)));
        c.addAction(item.createSetStartAction(time(start)));
        c.addAction(item.createSetEndAction(time(end)));
        for (const link of linked) {
          c.addAction(link.item.createSetInPointAction(time(link.inTicks)));
          c.addAction(link.item.createSetOutPointAction(time(link.outTicks)));
          c.addAction(link.item.createSetStartAction(time(link.startTicks)));
          c.addAction(link.item.createSetEndAction(time(link.endTicks)));
        }
      });
      for (const link of linked) {
        const actual = await snapshot(link.item, link.data.mediaType, link.data.trackIndex);
        assertAfter(sameSourceState(actual, link), "Linked trim readback failed");
      }
      const result = await resultFor(item, ctx, before, { trimmed: true, linkedItems: linked.map(link => ({ before: link.data, inTicks: link.inTicks, outTicks: link.outTicks, startTicks: link.startTicks, endTicks: link.endTicks })) });
      result.linkedAfter = [];
      result.linkedBefore = linked.map(link => link.data);
      for (const link of linked) {
        const after = await snapshot(link.item, link.data.mediaType, link.data.trackIndex);
        result.linkedAfter.push({ ...after, handle: issue(link.item, ctx.project, ctx.sequence, after) });
      }
      assertAfter(result.after.inTicks === sourceIn && result.after.outTicks === sourceOut && result.after.startTicks === start.toString() && result.after.endTicks === end.toString() && result.after.speed === before.speed && result.after.reverse === before.reverse, "Source trim readback failed");
      return verified(result, "Source in/out and sequence bounds with unchanged speed/reverse");
    }
    if (operation === "timeline.clip.remove" || operation === "pr.clip.remove") {
      if (args.linkedPolicy === "preserve" && !Array.isArray(args.linkedItems)) fail("LINK_MEMBERSHIP_UNAVAILABLE");
      const editor = ppro.SequenceEditor.getEditor(ctx.sequence), ripple = args.ripple === true;
      const selected = [target];
      for (const binding of args.linkedItems || []) {
        if (binding.mediaType === before.mediaType && binding.trackIndex === before.trackIndex && binding.startTicks === before.startTicks && binding.inTicks === before.inTicks) continue;
        selected.push(await find({ binding }, ctx));
      }
      const counts = new Map();
      for (const selectedItem of selected) {
        const key = selectedItem.data.mediaType + ":" + selectedItem.data.trackIndex;
        if (!counts.has(key)) counts.set(key, { data: selectedItem.data, before: (await enumerate(ctx.sequence, selectedItem.data.mediaType, selectedItem.data.trackIndex)).length, removed: 0 });
        counts.get(key).removed++;
      }
      const media = selected.length > 1 ? ppro.Constants.MediaType.ANY : before.mediaType === "audio" ? ppro.Constants.MediaType.AUDIO : ppro.Constants.MediaType.VIDEO;
      let callbackCalled = false;
      const selectionCreated = ppro.TrackItemSelection.createEmptySelection(selection => {
        callbackCalled = true;
        for (const selectedItem of selected) if (!selection.addItem(selectedItem.item, false)) fail("SELECTION_ADD_FAILED");
        transaction(ctx.project, "Remove clip", c => c.addAction(editor.createRemoveItemsAction(selection, ripple, media, args.shiftOverlapping === true)));
      });
      assertAfter(callbackCalled && selectionCreated !== false, "Removal selection callback failed");
      for (const entry of counts.values()) {
        const items = await enumerate(ctx.sequence, entry.data.mediaType, entry.data.trackIndex);
        assertAfter(items.length === entry.before - entry.removed && selected.every(selectedItem => !items.includes(selectedItem.item)), "Removal target remains or unexpected count");
      }
      return verified({ removed: true, before, ripple, removedItems: selected.map(selectedItem => selectedItem.data) }, "Target absence and count on exact track; callback-scoped selection");
    }
    if (operation === "timeline.clip.effect" || operation === "pr.effect.apply") {
      const name = string(args.effectName || args.matchName, "effectName"), mode = args.mode || "append";
      const list = await componentList(item), oldNames = list.components.map(c => c.matchName);
      let selected;
      if (mode === "remove") {
        const found = list.components.filter(c => (c.matchName === name || c.displayName === name) && (args.componentIndex === undefined || c.index === args.componentIndex));
        if (found.length !== 1) fail(found.length ? "EFFECT_AMBIGUOUS" : "EFFECT_NOT_FOUND");
        selected = found[0].component;
      } else {
        if (before.mediaType === "audio") {
          const displayNames = await ppro.AudioFilterFactory.getDisplayNames(), matches = displayNames.filter(n => n === name);
          if (matches.length !== 1) fail(matches.length ? "EFFECT_AMBIGUOUS" : "EFFECT_NOT_FOUND");
          selected = await ppro.AudioFilterFactory.createComponentByDisplayName(name, item);
        } else {
          const names = await ppro.VideoFilterFactory.getMatchNames();
          if (!names.includes(name)) fail("EFFECT_NOT_FOUND", "Use an exact installed match name");
          selected = await ppro.VideoFilterFactory.createComponent(name);
        }
      }
      if (!selected) fail("EFFECT_CREATION_FAILED");
      const expectedName = String(await selected.getMatchName());
      const selectedEntry = mode === "remove" ? list.components.find(entry => entry.component === selected) : undefined;
      await assertEditableBaseline(item, before, selectedEntry ? { componentIndex: selectedEntry.index, componentMatchName: selectedEntry.matchName } : undefined);
      transaction(ctx.project, "Change effect", c => c.addAction(mode === "remove" ? list.chain.createRemoveComponentAction(selected) : list.chain.createAppendComponentAction(selected)));
      const after = await componentList(item), names = after.components.map(c => c.matchName);
      const countBefore = oldNames.filter(n => n === expectedName).length;
      assertAfter(names.length === oldNames.length + (mode === "remove" ? -1 : 1) && names.filter(n => n === expectedName).length === countBefore + (mode === "remove" ? -1 : 1), "Effect chain readback failed");
      return verified(await resultFor(item, ctx, before, { mode, matchName: expectedName, componentNames: names }), "Exact component identity and chain delta");
    }
    if (operation === "pr.effects.inventory") {
      const list = await componentList(item), components = [];
      for (const entry of list.components) {
        const parameters = [];
        for (let i = 0; i < entry.component.getParamCount(); i++) {
          const p = entry.component.getParam(i), start = await p.getStartValue();
          const raw = start.value.value;
          parameters.push({ index: i, displayName: p.displayName, value: raw && typeof raw.x === "number" && typeof raw.y === "number" ? { x: raw.x, y: raw.y } : raw, timeVarying: p.isTimeVarying(), keys: p.getKeyframeListAsTickTimes().map(tick) });
        }
        components.push({ index: entry.index, matchName: entry.matchName, displayName: entry.displayName, parameters });
      }
      return verified({ components }, "Native component and parameter inventory");
    }
    if (["timeline.clip.parameter", "pr.parameter.set", "pr.audio.gain", "pr.title.setText", "pr.effects.reset_keyframes"].includes(operation)) {
      const { parameter, component } = await componentParameter(item, args);
      if (operation === "pr.effects.reset_keyframes") {
        const keys = parameter.getKeyframeListAsTickTimes();
        await assertEditableBaseline(item, before, { componentIndex: component.index, componentMatchName: component.matchName, parameterIndex: args.parameterIndex });
        transaction(ctx.project, "Remove parameter keyframes", c => {
          for (const key of keys) c.addAction(parameter.createRemoveKeyframeAction(key, true));
          c.addAction(parameter.createSetTimeVaryingAction(false));
        });
        assertAfter(parameter.getKeyframeListAsTickTimes().length === 0 && !parameter.isTimeVarying(), "Keyframes remain");
        return verified(await resultFor(item, ctx, before, { removedKeys: keys.length }), "Exact parameter keyframe list");
      }
      const entries = Array.isArray(args.keyframes) ? args.keyframes : [];
      if (new Set(entries.map(entry => tick(entry.ticks))).size !== entries.length) fail("INVALID_ARGUMENT", "Native keyframe times must be unique");
      const value = args.value;
      if (value === undefined && !entries.length) fail("PARAMETER_VALUE_REQUIRED");
      if (entries.length && !await parameter.areKeyframesSupported()) fail("KEYFRAMES_UNSUPPORTED");
      const nativeValue = value => {
        if (value && typeof value.x === "number" && typeof value.y === "number") { const point = new ppro.PointF(); point.x = value.x; point.y = value.y; return point; }
        return value;
      };
      await assertEditableBaseline(item, before, { componentIndex: component.index, componentMatchName: component.matchName, parameterIndex: args.parameterIndex });
      transaction(ctx.project, "Set parameter", c => {
        if (entries.length) {
          if (args.mode === "replace_keyframes") for (const old of parameter.getKeyframeListAsTickTimes()) c.addAction(parameter.createRemoveKeyframeAction(old, true));
          c.addAction(parameter.createSetTimeVaryingAction(true));
          for (const entry of entries) {
            const key = parameter.createKeyframe(nativeValue(entry.value));
            key.position = time(entry.ticks);
            c.addAction(parameter.createAddKeyframeAction(key));
            if (entry.interpolation !== undefined) {
              const interpolation = typeof entry.interpolation === "string" ? ppro.Constants.InterpolationMode[entry.interpolation.toUpperCase()] : entry.interpolation;
              if (interpolation === undefined) fail("INTERPOLATION_UNSUPPORTED");
              c.addAction(parameter.createSetInterpolationAtKeyframeAction(key.position, interpolation, true));
            }
          }
        } else {
          if (args.mode === "static") { for (const old of parameter.getKeyframeListAsTickTimes()) c.addAction(parameter.createRemoveKeyframeAction(old, true)); c.addAction(parameter.createSetTimeVaryingAction(false)); }
          c.addAction(parameter.createSetValueAction(parameter.createKeyframe(nativeValue(value)), false));
        }
      });
      const values = [];
      if (entries.length) for (const entry of entries) values.push({ ticks: tick(entry.ticks), value: await parameter.getValueAtTime(time(entry.ticks)) });
      else values.push({ value: (await parameter.getStartValue()).value.value });
      const expected = entries.length ? entries.map(e => e.value) : [value];
      for (const entry of values) if (entry.value && typeof entry.value.x === "number" && typeof entry.value.y === "number") entry.value = { x: entry.value.x, y: entry.value.y };
      assertAfter(values.every((v, i) => typeof v.value === "number" && typeof expected[i] === "number" ? Math.abs(v.value - expected[i]) <= 1e-7 : JSON.stringify(v.value) === JSON.stringify(expected[i])), "Parameter readback mismatch");
      if (args.mode === "static") assertAfter(!parameter.isTimeVarying() && parameter.getKeyframeListAsTickTimes().length === 0, "Static parameter still has an animation curve");
      const keyframeTicks = parameter.getKeyframeListAsTickTimes().map(tick), interpolationSamples = [];
      if (args.mode === "replace_keyframes") assertAfter(keyframeTicks.length === entries.length && entries.every(entry => keyframeTicks.includes(tick(entry.ticks))), "Native keyframe inventory differs from the replacement curve");
      if (operation === "pr.audio.gain" && entries.length) {
        const sorted = entries.slice().sort((a, b) => BigInt(tick(a.ticks)) < BigInt(tick(b.ticks)) ? -1 : 1);
        for (let index = 1; index < sorted.length; index++) {
          const start = sorted[index - 1], end = sorted[index], from = BigInt(tick(start.ticks)), delta = BigInt(tick(end.ticks)) - from;
          if (delta <= 1n) continue;
          const at = from + delta / 2n, observed = await parameter.getValueAtTime(time(String(at)));
          const wanted = start.value + (end.value - start.value) * Number(at - from) / Number(delta);
          assertAfter(typeof observed === "number" && Number.isFinite(observed) && Math.abs(observed - wanted) <= 1e-7, "Native gain interpolation differs from the requested linear envelope");
          interpolationSamples.push({ ticks: String(at), value: observed });
        }
      }
      return verified(await resultFor(item, ctx, before, { values, keyframeTicks, interpolationSamples, componentMatchName: args.componentMatchName, parameterIndex: args.parameterIndex }), "Exact parameter values and native keyframe inventory, with linear gain interval readback");
    }
    if (operation === "timeline.clip.add_transition") {
      if (before.mediaType !== "video") fail("TRANSITION_MEDIA_UNSUPPORTED");
      const name = string(args.matchName, "matchName"), names = await ppro.TransitionFactory.getVideoTransitionMatchNames();
      if (!names.includes(name)) fail("TRANSITION_NOT_FOUND", "Use an exact installed transition match name");
      const transition = ppro.TransitionFactory.createVideoTransition(name);
      transaction(ctx.project, "Add transition", c => c.addAction(item.createAddVideoTransitionAction(transition, args.options)));
      // No public transition enumeration is available in 26.3; never label a transaction as readback.
      return { result: { applied: true, matchName: name }, verification: { outcome: "committed_unverified", method: "Transaction accepted; native transition state requires qualified readback" } };
    }
    if (operation === "pr.clip.replaceSource") fail("EXACT_REPLACE_SOURCE_UNAVAILABLE", "Use project-item relink only when all occurrences should change; a single native clip replacement preserving its effects requires a qualified host adapter");
    fail("OPERATION_NOT_IMPLEMENTED", operation);
  }
  async function editSegments(args, ctx) {
    const segments = args.segments;
    if (!Array.isArray(segments) || !segments.length || segments.length > 128) fail("INVALID_ARGUMENT", "1..128 segments required");
    const editor = ppro.SequenceEditor.getEditor(ctx.sequence), results = [];
    for (const segment of segments) {
      const projectItem = await itemById(ctx.project, segment.projectItemId);
      const sourceIn = time(segment.sourceInTicks), sourceOut = time(segment.sourceOutTicks), start = time(segment.timelineStartTicks);
      if (BigInt(sourceOut.ticks) <= BigInt(sourceIn.ticks)) fail("INVALID_SOURCE_RANGE");
      const oldIn = await projectItem.getInPoint(ppro.Constants.MediaType.ANY), oldOut = await projectItem.getOutPoint(ppro.Constants.MediaType.ANY);
      const videoTrack = segment.videoTrackIndex === undefined ? -1 : segment.videoTrackIndex, audioTrack = segment.audioTrackIndex === undefined ? -1 : segment.audioTrackIndex;
      if (videoTrack < 0 && audioTrack < 0) fail("TARGET_TRACK_REQUIRED");
      const mediaType = videoTrack >= 0 ? "video" : "audio", trackIndex = videoTrack >= 0 ? videoTrack : audioTrack;
      const prior = await enumerate(ctx.sequence, mediaType, trackIndex);
      let restored = false;
      try {
        transaction(ctx.project, "Select source range", c => c.addAction(projectItem.createSetInOutPointsAction(sourceIn, sourceOut)));
        transaction(ctx.project, "Place source segment", c => c.addAction(args.mode === "overwrite" ? editor.createOverwriteItemAction(projectItem, start, videoTrack, audioTrack) : editor.createInsertProjectItemAction(projectItem, start, videoTrack, audioTrack, true)));
      } finally {
        transaction(ctx.project, "Restore source monitor range", c => c.addAction(projectItem.createSetInOutPointsAction(oldIn, oldOut)));
        restored = true;
      }
      const candidates = [];
      for (const item of await enumerate(ctx.sequence, mediaType, trackIndex)) {
        const data = await snapshot(item, mediaType, trackIndex);
        if (data.projectItemId === identity(projectItem) && data.startTicks === start.ticks && data.inTicks === sourceIn.ticks && data.outTicks === sourceOut.ticks) candidates.push({ item, data });
      }
      assertAfter(restored && candidates.length === 1, "Placed segment did not match source and timeline");
      const found = candidates[0];
      constantClips.add(found.item);
      results.push({ itemKey: segment.itemKey, ...found.data, handle: issue(found.item, ctx.project, ctx.sequence, found.data), priorCount: prior.length });
    }
    return verified({ projectGuid: identity(ctx.project), sequenceGuid: identity(ctx.sequence), clips: results }, "Each inserted segment source range and exact timeline start");
  }
  async function submitExport(args, ctx) {
    const id = string(args.exportJobId, "exportJobId");
    const encoder = ppro.EncoderManager.getManager(), outputPath = string(args.outputPath, "outputPath"), presetPath = string(args.presetPath, "presetPath");
    const requestSignature = JSON.stringify({ projectGuid: identity(ctx.project), sequenceGuid: identity(ctx.sequence), outputPath, presetPath, range: args.range || args.output && args.output.range || { kind: "whole_sequence" }, queueToAME: args.queueToAME === true });
    if (exportJobs.has(id)) {
      if (exportJobs.get(id).requestSignature !== requestSignature) fail("EXPORT_IDEMPOTENCY_CONFLICT", "Export job ID already represents another target/output/range");
      return verified({ ...exportJobs.get(id) }, "Existing export job dispatch receipt; completion remains separately observed");
    }
    if (!encoderListeners) {
      for (const [eventName, state] of [[ppro.EncoderManager.EVENT_RENDER_QUEUE,"QUEUED"],[ppro.EncoderManager.EVENT_RENDER_PROGRESS,"RUNNING"],[ppro.EncoderManager.EVENT_RENDER_COMPLETE,"SUCCEEDED"],[ppro.EncoderManager.EVENT_RENDER_ERROR,"FAILED"],[ppro.EncoderManager.EVENT_RENDER_CANCEL,"CANCELLED"]]) {
        ppro.EventManager.addEventListener(encoder, eventName, event => {
          const data = event && (event.data || event) || {}, hostJobId = data.jobID || data.jobId;
          const files = Array.isArray(data.outputFiles) ? data.outputFiles : data.outputFile ? [data.outputFile] : [];
          for (const job of exportJobs.values()) {
            const sameJob = job.hostJobId && hostJobId && String(job.hostJobId) === String(hostJobId);
            const sameOutput = files.some(file => pathKey(typeof file === "string" ? file : file.path) === pathKey(job.outputPath));
            if (!sameJob && !sameOutput) continue;
            if (hostJobId) job.hostJobId = String(hostJobId);
            job.status = state; job.progress = data.progressAmount; job.updatedAt = new Date().toISOString();
            if (state === "FAILED") job.error = String(data.errorMessage || data.error || "Encoder failure");
            if (state === "SUCCEEDED") job.completedOutputFiles = files;
          }
        }, false);
      }
      encoderListeners = true;
    }
    const sequenceEnd = BigInt(tick(await ctx.sequence.getEndTime()));
    const requestedRange = args.range || args.output && args.output.range;
    let start = 0n, end = sequenceEnd, originalRange;
    if (requestedRange && requestedRange.kind !== "whole_sequence") {
      const value = requestedRange.value || requestedRange;
      start = BigInt(tick(value.start || value.startTicks)); end = BigInt(tick(value.end || value.endTicks));
      if (start < 0n || end <= start || end > sequenceEnd) fail("OUTPUT_RANGE_INVALID");
      originalRange = { startTicks: tick(await ctx.sequence.getInPoint()), endTicks: tick(await ctx.sequence.getOutPoint()) };
      transaction(ctx.project, "Set explicit export range", c => {
        c.addAction(ctx.sequence.createSetInPointAction(time(start)));
        c.addAction(ctx.sequence.createSetOutPointAction(time(end)));
      });
      assertAfter(tick(await ctx.sequence.getInPoint()) === start.toString() && tick(await ctx.sequence.getOutPoint()) === end.toString(), "Export range readback failed");
    }
    if (end <= start) fail("OUTPUT_RANGE_INVALID", "Cannot export an empty sequence");
    const job = { exportJobId: id, requestSignature, status: "DISPATCHED", sequenceGuid: identity(ctx.sequence), projectGuid: identity(ctx.project), outputPath, presetPath,
      queueToAME: args.queueToAME === true, range: { startTicks: start.toString(), endTicks: end.toString() }, expectedDurationTicks: (end - start).toString(),
      ...(originalRange ? { originalRange } : {}), createdAt: new Date().toISOString(), cancelSupported: false, pauseResumeSupported: false };
    exportJobs.set(id, job);
    const pending = encoder.exportSequence(ctx.sequence, args.queueToAME ? ppro.Constants.ExportType.QUEUE_TO_AME : ppro.Constants.ExportType.IMMEDIATELY, outputPath, presetPath, !originalRange);
    Promise.resolve(pending).then(accepted => {
      if (accepted !== true && job.status !== "SUCCEEDED") { job.status = "FAILED"; job.error = "EXPORT_NOT_ACCEPTED"; }
      else if (job.status === "DISPATCHED") job.status = args.queueToAME ? "QUEUED" : "DISPATCH_RETURNED";
    }).catch(error => { if (job.status !== "SUCCEEDED") { job.status = "FAILED"; job.error = String(error); } });
    return { result: { ...job }, verification: { outcome: job.status === "SUCCEEDED" ? "verified" : "committed_unverified", method: "Encoder accepts work; only matching terminal event proves completion" } };
  }
  return { operations: OPERATIONS, execute };
}
module.exports = { createSemanticOperations, OPERATIONS };
