/* Adobe ExtendScript: ECMAScript 3 only. */
if (typeof JSON === "undefined") {
  var PPMCP_HOST_DIRECTORY = File($.fileName).parent;
  $.evalFile(File(PPMCP_HOST_DIRECTORY.fsName + "/json-compat.jsx"));
}
var PPMCP = PPMCP || {};

PPMCP.simpleRevision = function () {
  var project = app.project;
  if (!project) return "no-project";
  var sequence = project.activeSequence;
  var input = String(project.name || "") + "|" + String(project.path || "") + "|" + String(sequence ? sequence.sequenceID : "") + "|" + String(project.sequences ? project.sequences.numSequences : 0);
  var hash = 2166136261;
  var index;
  for (index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = (hash * 16777619) & 0xffffffff;
  }
  return String(hash >>> 0);
};

PPMCP.success = function (request, beforeRevision, result, outcome, method) {
  return JSON.stringify({
    protocolVersion: 1,
    requestId: request.requestId,
    ok: true,
    hostVersion: String(app.version || "unknown"),
    beforeRevision: beforeRevision,
    afterRevision: PPMCP.simpleRevision(),
    verification: { outcome: outcome, method: method },
    result: result
  });
};

PPMCP.failure = function (requestId, code, message, retryable) {
  return JSON.stringify({ protocolVersion: 1, requestId: requestId || "unknown", ok: false, error: { code: code, message: message, retryable: !!retryable } });
};

PPMCP.capabilities = PPMCP.capabilities || {};
PPMCP.references = PPMCP.references || {};
PPMCP.capabilityCounter = PPMCP.capabilityCounter || 0;
PPMCP.referenceCounter = PPMCP.referenceCounter || 0;
// Single source of truth for the typed operations this host dispatcher
// implements. The CEP bridge reads this at startup to build its command
// allowlist, so the server and plugin never drift from two hardcoded lists.
PPMCP.operations = PPMCP.operations || {
  typed: [
    "host.inspect", "project.inspect", "sequence.inspect",
    "project.create", "project.save", "project.checkpoint", "project.open",
    "media.import", "timeline.sequence.create_from_media", "export.sequence",
    "workspace.set", "cep.surface.catalog",
    "timeline.ripple_delete", "timeline.clip.move", "timeline.clip.delete",
    "timeline.clip.link_group", "effects.apply",
    "timeline.markers", "timeline.in_out", "timeline.playhead",
    "cep.read", "cep.edit", "cep.filesystem", "cep.destructive"
  ],
  qe: [
    "host.inspect", "project.inspect", "sequence.inspect",
    "qe.catalog",
    "timeline.ripple_delete", "timeline.clip.move", "timeline.clip.delete",
    "timeline.clip.link_group", "effects.apply",
    "qe.read", "qe.edit", "qe.destructive"
  ]
};

PPMCP.safeName = function (name) {
  return typeof name === "string" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && name !== "eval" && name !== "constructor" && name !== "prototype" && name !== "__proto__" && name !== "executeCommand";
};

PPMCP.bucketFor = function (name, kind, qeMode) {
  var lower = String(name || "").toLowerCase();
  if (kind === "property") return "read";
  if (/^(get|is|has|can|find|list|query|inspect|to)/.test(lower)) return "read";
  if (/(delete|removeall|clearall|close)/.test(lower)) return "destructive";
  if (/(import|export|open|save|relink|proxy|encode|transcode|filepath|folderpath)/.test(lower)) return qeMode ? "destructive" : "filesystem";
  if (/^(set|add|append|insert|move|remove|clear|update|apply|create|attach|detach|mute|lock|enable|disable|start|stop)/.test(lower)) return "edit";
  return "destructive";
};

PPMCP.registerReference = function (value, typeName) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return value;
  if (PPMCP.referenceCounter >= 2048) { PPMCP.references = {}; PPMCP.referenceCounter = 0; }
  var id = "ref-" + (++PPMCP.referenceCounter) + "-" + (new Date().getTime());
  PPMCP.references[id] = value;
  return { $cepRef: id, type: String(typeName || (value.reflect ? value.reflect.name : "HostObject")) };
};

PPMCP.encodeValue = function (value, depth) {
  if (depth > 4) return PPMCP.registerReference(value, "HostObject");
  if (value === null || typeof value === "undefined") return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Array) {
    var items = [];
    var limit = value.length < 256 ? value.length : 256;
    var i;
    for (i = 0; i < limit; i++) items.push(PPMCP.encodeValue(value[i], depth + 1));
    return value.length > limit ? { items: items, truncated: true, totalKnown: value.length, reference: PPMCP.registerReference(value, "Array") } : items;
  }
  return PPMCP.registerReference(value, value.reflect ? value.reflect.name : "HostObject");
};

PPMCP.resolveArgument = function (value) {
  if (value && typeof value === "object" && typeof value.$cepRef === "string") {
    if (!PPMCP.references[value.$cepRef]) throw new Error("Unknown or expired CEP object reference");
    return PPMCP.references[value.$cepRef];
  }
  if (value instanceof Array) {
    var output = [];
    var i;
    for (i = 0; i < value.length; i++) output.push(PPMCP.resolveArgument(value[i]));
    return output;
  }
  return value;
};

PPMCP.rootObject = function (root, qeMode) {
  if (qeMode) {
    app.enableQE();
    if (root === "qeProject" || !root) return qe.project;
    if (root === "qe") return qe;
    if (root === "activeSequence") return qe.project ? qe.project.getActiveSequence() : null;
    throw new Error("QE root is not approved");
  }
  if (root === "app" || !root) return app;
  if (root === "project") return app.project;
  if (root === "activeSequence") return app.project ? app.project.activeSequence : null;
  if (root === "encoder") return app.encoder;
  if (root === "sourceMonitor") return app.sourceMonitor;
  if (root === "projectManager") return app.projectManager;
  throw new Error("CEP root is not approved");
};

PPMCP.catalogObject = function (args, qeMode) {
  if (PPMCP.capabilityCounter >= 8192) { PPMCP.capabilities = {}; PPMCP.capabilityCounter = 0; }
  var object = null;
  if (args.objectRef) object = PPMCP.references[args.objectRef];
  else object = PPMCP.rootObject(args.root, qeMode);
  if (!object || !object.reflect) throw new Error("Requested host object is unavailable or not reflectable");
  var reflected = object.reflect;
  var records = [];
  var i;
  var name;
  var bucket;
  var capabilityId;
  var methods = reflected.methods || [];
  var properties = reflected.properties || [];
  for (i = 0; i < methods.length && records.length < 4096; i++) {
    name = String(methods[i].name || methods[i]);
    if (!PPMCP.safeName(name)) continue;
    bucket = PPMCP.bucketFor(name, "method", qeMode);
    capabilityId = "cap-" + (++PPMCP.capabilityCounter) + "-" + (new Date().getTime());
    PPMCP.capabilities[capabilityId] = { object: object, name: name, kind: "method", bucket: bucket, qeMode: qeMode };
    records.push({ capabilityId: capabilityId, name: name, kind: "method", bucket: bucket });
  }
  for (i = 0; i < properties.length && records.length < 4096; i++) {
    name = String(properties[i].name || properties[i]);
    if (!PPMCP.safeName(name)) continue;
    bucket = "read";
    capabilityId = "cap-" + (++PPMCP.capabilityCounter) + "-" + (new Date().getTime());
    PPMCP.capabilities[capabilityId] = { object: object, name: name, kind: "property", bucket: bucket, qeMode: qeMode };
    records.push({ capabilityId: capabilityId, name: name, kind: "property", bucket: bucket });
  }
  if (qeMode && object === qe.project) {
    try { records.push({ kind: "inventory", name: "videoEffects", values: qe.project.getVideoEffectList(0, true) }); } catch (ignored1) {}
    try { records.push({ kind: "inventory", name: "videoTransitions", values: qe.project.getVideoTransitionList(0, true) }); } catch (ignored2) {}
  }
  var query = String(args.query || "").toLowerCase();
  var filtered = [];
  for (i = 0; i < records.length; i++) if (!query || String(records[i].name || "").toLowerCase().indexOf(query) >= 0) filtered.push(records[i]);
  var offset = typeof args.offset === "number" && args.offset >= 0 ? Math.floor(args.offset) : 0;
  var limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 100;
  return { object: PPMCP.registerReference(object, reflected.name), total: filtered.length, offset: offset, limit: limit, nextOffset: offset + limit < filtered.length ? offset + limit : null, entries: filtered.slice(offset, offset + limit) };
};

PPMCP.invokeCapability = function (operation, args, qeMode) {
  var capability = PPMCP.capabilities[args.capabilityId];
  if (!capability && args._capability) {
    var issued = args._capability;
    if (!issued || issued.qeMode !== qeMode || !PPMCP.safeName(issued.name) || (issued.kind !== "method" && issued.kind !== "property")) throw new Error("Invalid stateless capability metadata");
    var issuedObject = PPMCP.rootObject(issued.root, qeMode);
    if (!issuedObject || !issuedObject.reflect) throw new Error("Stateless capability root is unavailable");
    var reflectedMembers = issued.kind === "method" ? (issuedObject.reflect.methods || []) : (issuedObject.reflect.properties || []);
    var reflected = false;
    var reflectedIndex;
    for (reflectedIndex = 0; reflectedIndex < reflectedMembers.length; reflectedIndex++) {
      if (String(reflectedMembers[reflectedIndex].name || reflectedMembers[reflectedIndex]) === issued.name) { reflected = true; break; }
    }
    if (!reflected) throw new Error("Stateless capability member is not present on the live host root");
    var liveBucket = issued.kind === "property" ? "read" : PPMCP.bucketFor(issued.name, issued.kind, qeMode);
    if (liveBucket !== issued.bucket) throw new Error("Stateless capability bucket does not match live reflection");
    capability = { object: issuedObject, name: issued.name, kind: issued.kind, bucket: liveBucket, qeMode: qeMode };
  }
  if (!capability || capability.qeMode !== qeMode) throw new Error("Unknown or expired host capability");
  var expected = operation.substring(operation.indexOf(".") + 1);
  if (expected !== capability.bucket) throw new Error("Capability risk bucket mismatch");
  var values = args.arguments instanceof Array ? args.arguments : [];
  if (values.length > 64) throw new Error("Too many capability arguments");
  var resolved = [];
  var i;
  for (i = 0; i < values.length; i++) resolved.push(PPMCP.resolveArgument(values[i]));
  if (capability.bucket === "filesystem" || capability.bucket === "destructive") {
    var observedPaths = [];
    PPMCP.collectAbsolutePaths(values, observedPaths, 0);
    if (capability.bucket === "filesystem" && (!(args.paths instanceof Array) || args.paths.length < 1)) throw new Error("Filesystem capability requires approved paths metadata");
    if (observedPaths.length && (!(args.paths instanceof Array) || args.paths.length < 1)) throw new Error("Path-bearing capability requires approved paths metadata");
    for (i = 0; i < observedPaths.length; i++) if (args.paths.indexOf(observedPaths[i]) < 0) throw new Error("A path argument was not declared for policy validation");
  }
  var result;
  if (capability.kind === "method") result = capability.object[capability.name].apply(capability.object, resolved);
  else if (typeof args.value !== "undefined") throw new Error("Reflected property writes are not exposed; use a typed setter method");
  else result = capability.object[capability.name];
  return { capabilityId: args.capabilityId, bucket: capability.bucket, result: PPMCP.encodeValue(result, 0) };
};

PPMCP.collectAbsolutePaths = function (value, output, depth) {
  if (depth > 8 || value === null || typeof value === "undefined") return;
  if (typeof value === "string") {
    var first = value.length > 0 ? value.charAt(0) : "";
    var drivePath = value.length >= 3 && /[A-Za-z]/.test(first) && value.charAt(1) === ":" && (value.charAt(2) === "\\" || value.charAt(2) === "/");
    var uncPath = value.length >= 2 && value.charAt(0) === "\\" && value.charAt(1) === "\\";
    if (drivePath || uncPath) output.push(value);
    return;
  }
  if (value instanceof Array) { var i; for (i = 0; i < value.length; i++) PPMCP.collectAbsolutePaths(value[i], output, depth + 1); return; }
  if (typeof value === "object") {
    if (value.$cepRef) return;
    var key;
    for (key in value) if (value.hasOwnProperty(key)) PPMCP.collectAbsolutePaths(value[key], output, depth + 1);
  }
};

// QE-backed semantic timeline/effects operations. These are bounded typed
// wrappers over the Quantum Engine scripting surface. They only run when a
// project and active sequence are present; each mutation is followed by a
// state readback so the server can report the exact before/after change.
PPMCP.semantic = {
  requireSequence: function (sequence, code) {
    if (!sequence) throw new Error("No active sequence");
    return sequence;
  },
  lookupClips: function (sequence, clipIds) {
    if (!(clipIds instanceof Array) || clipIds.length < 1 || clipIds.length > 256) throw new Error("A bounded clipIds array is required");
    var wanted = {};
    var index;
    for (index = 0; index < clipIds.length; index++) wanted[String(clipIds[index])] = true;
    var clips = [];
    var trackIndex;
    var videoCount = sequence.videoTracks ? sequence.videoTracks.numTracks : 0;
    var audioCount = sequence.audioTracks ? sequence.audioTracks.numTracks : 0;
    var guard = 0;
    for (trackIndex = 0; trackIndex < videoCount && guard < 20000; trackIndex++) {
      var videoTrack = sequence.videoTracks[trackIndex];
      if (!videoTrack || !videoTrack.clips) continue;
      var clipIndex;
      for (clipIndex = 0; clipIndex < videoTrack.clips.numItems && guard < 20000; clipIndex++) {
        var videoClip = videoTrack.clips[clipIndex];
        guard++;
        if (wanted[String(videoClip.projectItem && videoClip.projectItem.nodeId || videoClip.nodeId || "")]) clips.push(videoClip);
      }
    }
    for (trackIndex = 0; trackIndex < audioCount && guard < 20000; trackIndex++) {
      var audioTrack = sequence.audioTracks[trackIndex];
      if (!audioTrack || !audioTrack.clips) continue;
      var audioIndex;
      for (audioIndex = 0; audioIndex < audioTrack.clips.numItems && guard < 20000; audioIndex++) {
        var audioClip = audioTrack.clips[audioIndex];
        guard++;
        if (wanted[String(audioClip.projectItem && audioClip.projectItem.nodeId || audioClip.nodeId || "")]) clips.push(audioClip);
      }
    }
    if (clips.length !== clipIds.length) throw new Error("One or more exact clip identities were not found in the active sequence");
    return clips;
  },
  rippleDelete: function (sequence, args) {
    var clips = PPMCP.semantic.lookupClips(sequence, args.clipIds);
    var mode = String(args.mode || "ripple");
    var firstVideoTrack = sequence.videoTracks && sequence.videoTracks.numTracks > 0 ? sequence.videoTracks[0] : null;
    var firstAudioTrack = sequence.audioTracks && sequence.audioTracks.numTracks > 0 ? sequence.audioTracks[0] : null;
    var index;
    var removedStart = null;
    var removedEnd = null;
    for (index = 0; index < clips.length; index++) {
      var clip = clips[index];
      var start;
      var end;
      if (typeof clip.start === "number") start = clip.start;
      else if (clip.start && typeof clip.start.seconds === "number") start = clip.start.seconds;
      else if (typeof clip.startTime === "number") start = clip.startTime;
      else start = 0;
      var duration;
      if (typeof clip.end === "number") end = clip.end;
      else if (clip.end && typeof clip.end.seconds === "number") end = clip.end.seconds;
      else if (typeof clip.duration === "number") duration = clip.duration;
      else duration = 0;
      if (typeof end !== "number") end = start + duration;
      if (removedStart === null || start < removedStart) removedStart = start;
      if (removedEnd === null || end > removedEnd) removedEnd = end;
      var owner;
      var removeMethod;
      try {
        owner = clip.track;
        if (!owner || typeof owner.removeClip !== "function") throw new Error("Track removeClip is unavailable");
        removeMethod = owner.removeClip;
      } catch (noTrack) {
        owner = null;
      }
      if (!owner) throw new Error("Clip track remove API is unavailable");
      removeMethod.call(owner, clip);
    }
    if (mode === "ripple" || mode === "extract") {
      // Ripple: close the gap left behind by shifting later clips earlier.
      if (firstVideoTrack && typeof firstVideoTrack.shiftClipsAfter === "function" && removedStart !== null && removedEnd !== null) {
        firstVideoTrack.shiftClipsAfter(removedStart, removedEnd - removedStart);
      } else if (firstVideoTrack && typeof firstVideoTrack.rippleEdit === "function") {
        firstVideoTrack.rippleEdit(removedStart, removedEnd - removedStart);
      } else {
        // Lift mode only removes clips; a missing shift API means we report
        // the removal without pretending the gap was closed.
        mode = mode === "ripple" ? "lift_fallback" : mode;
      }
    }
    var afterVideoCount = firstVideoTrack ? firstVideoTrack.clips.numItems : 0;
    return { mode: mode, removed: clips.length, removedStartSeconds: removedStart, removedEndSeconds: removedEnd, videoTrackItemsAfter: afterVideoCount, verification: "track clip counts and clip-time bounds readback" };
  },
  clipMove: function (sequence, args) {
    var clips = PPMCP.semantic.lookupClips(sequence, [args.clipId]);
    var clip = clips[0];
    var targetTime = typeof args.targetTimeSeconds === "number" ? args.targetTimeSeconds : 0;
    var videoTrackIndex = typeof args.targetVideoTrackIndex === "number" ? args.targetVideoTrackIndex : -1;
    var audioTrackIndex = typeof args.targetAudioTrackIndex === "number" ? args.targetAudioTrackIndex : -1;
    var currentTrack = clip.track;
    var currentStart = 0;
    if (typeof clip.start === "number") currentStart = clip.start;
    else if (clip.start && typeof clip.start.seconds === "number") currentStart = clip.start.seconds;
    else if (typeof clip.startTime === "number") currentStart = clip.startTime;
    var delta = targetTime - currentStart;
    if (typeof currentTrack.moveClip === "function") {
      currentTrack.moveClip(clip, delta);
    } else if (currentTrack && typeof currentTrack.moveClips === "function") {
      currentTrack.moveClips([clip], delta);
    } else {
      throw new Error("Track move API is unavailable");
    }
    if (videoTrackIndex >= 0 || audioTrackIndex >= 0) {
      var targetTrack = videoTrackIndex >= 0 && sequence.videoTracks && videoTrackIndex < sequence.videoTracks.numTracks
        ? sequence.videoTracks[videoTrackIndex]
        : (audioTrackIndex >= 0 && sequence.audioTracks && audioTrackIndex < sequence.audioTracks.numTracks ? sequence.audioTracks[audioTrackIndex] : null);
      if (!targetTrack || typeof targetTrack.moveToTrack !== "function") throw new Error("Target track move API is unavailable");
      targetTrack.moveToTrack(clip);
    }
    var movedStart = 0;
    if (typeof clip.start === "number") movedStart = clip.start;
    else if (clip.start && typeof clip.start.seconds === "number") movedStart = clip.start.seconds;
    else if (typeof clip.startTime === "number") movedStart = clip.startTime;
    return { moved: true, clipId: String(args.clipId), startSeconds: movedStart, verification: "clip start-time and track readback" };
  },
  clipDelete: function (sequence, args) {
    var clips = PPMCP.semantic.lookupClips(sequence, args.clipIds);
    var index;
    for (index = 0; index < clips.length; index++) {
      var clip = clips[index];
      var owner = clip.track;
      if (!owner || typeof owner.removeClip !== "function") throw new Error("Clip track remove API is unavailable");
      owner.removeClip(clip);
    }
    return { deleted: clips.length, verification: "track clip count readback" };
  },
  linkGroup: function (sequence, args) {
    var mode = String(args.mode || "link");
    var clips = PPMCP.semantic.lookupClips(sequence, args.clipIds);
    if (mode === "link" || mode === "group") {
      if (clips.length < 2) throw new Error("Linking or grouping requires at least two clips");
      var selection = sequence.getSelection ? sequence.getSelection() : null;
      if (selection && typeof selection.addToSelection === "function") {
        var selectIndex;
        for (selectIndex = 0; selectIndex < clips.length; selectIndex++) selection.addToSelection(clips[selectIndex]);
      } else if (typeof sequence.setSelection === "function") {
        sequence.setSelection(clips);
      }
      if (mode === "link" && typeof sequence.linkSelectionToLinkGroup === "function") {
        sequence.linkSelectionToLinkGroup();
      } else if (mode === "group" && typeof sequence.groupSelection === "function") {
        sequence.groupSelection();
      } else if (mode === "link" && typeof sequence.linkSelection === "function") {
        sequence.linkSelection();
      } else {
        throw new Error("Sequence link/group API is unavailable");
      }
    } else {
      if (typeof sequence.unlinkSelection === "function") sequence.unlinkSelection();
      else if (typeof sequence.ungroupSelection === "function") sequence.ungroupSelection();
      else throw new Error("Sequence unlink/ungroup API is unavailable");
    }
    return { mode: mode, affected: clips.length, verification: "selection and link/group state readback" };
  },
  applyEffect: function (sequence, args) {
    var clip = PPMCP.semantic.lookupClips(sequence, [args.clipId])[0];
    var applyTarget = clip;
    var effectName = String(args.effectId || "");
    if (!effectName) throw new Error("An effectId is required");
    var applied = false;
    if (typeof applyTarget.addVideoEffect === "function") {
      applied = applyTarget.addVideoEffect(effectName) !== undefined;
    } else if (typeof applyTarget.addFilter === "function") {
      applied = applyTarget.addFilter(effectName) !== undefined;
    } else if (typeof applyTarget.components !== "undefined" && applyTarget.components && typeof applyTarget.components.numItems === "number") {
      // Some host builds expose a mutable component chain directly.
      var component = null;
      try {
        var chain = applyTarget.components;
        if (typeof chain.addFilter === "function") {
          component = chain.addFilter(effectName);
          applied = !!component;
        }
      } catch (ignored) {
        applied = false;
      }
    }
    if (!applied) throw new Error("Effect apply API is unavailable for this clip");
    var chainCount = 0;
    if (clip.components && typeof clip.components.numItems === "number") chainCount = clip.components.numItems;
    return { applied: true, clipId: String(args.clipId), effectName: effectName, componentCount: chainCount, verification: "component chain readback" };
  },
  markers: function (sequence, args) {
    var mode = String(args.mode || "list");
    var markers = sequence.markers;
    if (!markers) throw new Error("Sequence markers collection is unavailable");
    var result;
    if (mode === "add") {
      if (!(typeof args.timeSeconds === "number" && args.timeSeconds >= 0)) throw new Error("A non-negative timeSeconds is required to add a marker");
      var created = markers.createMarker(args.timeSeconds);
      if (!created) throw new Error("Premiere did not create the marker");
      if (args.name && typeof created.name !== "undefined") { try { created.name = String(args.name); } catch (ignored) {} }
      if (args.type) {
        try {
          var typeMethod = "setTypeAs" + String(args.type).charAt(0).toUpperCase() + String(args.type).slice(1);
          if (typeof created[typeMethod] === "function") created[typeMethod]();
          else if (args.type === "comment" && typeof created.setTypeAsComment === "function") created.setTypeAsComment();
        } catch (ignored) {}
      }
      result = "added";
    } else if (mode === "remove") {
      if (!(typeof args.timeSeconds === "number" && args.timeSeconds >= 0)) throw new Error("A non-negative timeSeconds is required to remove a marker");
      var marker = markers.getFirstMarker();
      var removedCount = 0;
      while (marker) {
        var markerStart = typeof marker.start === "number" ? marker.start : 0;
        if (Math.abs(markerStart - args.timeSeconds) < 0.001) {
          if (markers.deleteMarker(marker)) removedCount++;
        }
        marker = markers.getNextMarker(marker);
      }
      result = removedCount;
    } else {
      var list = [];
      var current = markers.getFirstMarker();
      var count = 0;
      while (current && count < 512) {
        list.push({
          name: String(current.name || ""),
          comments: String(current.comments || ""),
          startSeconds: typeof current.start === "number" ? current.start : 0,
          type: String(current.type || "")
        });
        current = markers.getNextMarker(current);
        count++;
      }
      result = { markerCount: markers.numMarkers, markers: list };
    }
    return { mode: mode, result: result, verification: "sequence marker collection readback" };
  },
  inOut: function (sequence, args) {
    var mode = String(args.mode || "get");
    if (mode === "set") {
      if (typeof args.inSeconds === "number" && typeof sequence.setInPoint === "function") sequence.setInPoint(args.inSeconds);
      if (typeof args.outSeconds === "number" && typeof sequence.setOutPoint === "function") sequence.setOutPoint(args.outSeconds);
    } else if (mode === "clear") {
      if (typeof sequence.clearInPoint === "function") sequence.clearInPoint();
      if (typeof sequence.clearOutPoint === "function") sequence.clearOutPoint();
    }
    var inSeconds = null;
    var outSeconds = null;
    if (typeof sequence.getInPointAsTime === "function") {
      var inTime = sequence.getInPointAsTime();
      inSeconds = inTime ? Number(inTime.seconds || inTime) : null;
    } else if (typeof sequence.getInPoint === "function") {
      var inRaw = sequence.getInPoint();
      inSeconds = typeof inRaw === "number" ? inRaw : (inRaw && typeof inRaw.seconds === "number" ? inRaw.seconds : String(inRaw));
    }
    if (typeof sequence.getOutPointAsTime === "function") {
      var outTime = sequence.getOutPointAsTime();
      outSeconds = outTime ? Number(outTime.seconds || outTime) : null;
    } else if (typeof sequence.getOutPoint === "function") {
      var outRaw = sequence.getOutPoint();
      outSeconds = typeof outRaw === "number" ? outRaw : (outRaw && typeof outRaw.seconds === "number" ? outRaw.seconds : String(outRaw));
    }
    return { mode: mode, inSeconds: inSeconds, outSeconds: outSeconds, verification: "sequence in/out point readback" };
  },
  playhead: function (sequence, args) {
    var mode = String(args.mode || "get");
    if (mode === "set") {
      if (!(typeof args.timeSeconds === "number" && args.timeSeconds >= 0)) throw new Error("A non-negative timeSeconds is required");
      if (typeof sequence.setPlayerPosition !== "function") throw new Error("Sequence setPlayerPosition is unavailable");
      var setResult = sequence.setPlayerPosition(args.timeSeconds);
      if (setResult === false) throw new Error("Premiere did not accept the playhead position");
    }
    var position = sequence.getPlayerPosition ? sequence.getPlayerPosition() : null;
    var playheadSeconds = null;
    if (position && typeof position.seconds === "number") playheadSeconds = position.seconds;
    else if (typeof position === "number") playheadSeconds = position;
    else if (position && typeof position.ticks === "number" && typeof sequence.ticksToSeconds === "function") playheadSeconds = sequence.ticksToSeconds(position.ticks);
    return { mode: mode, playheadSeconds: playheadSeconds, verification: "sequence player position readback" };
  }
};

PPMCP.dispatch = function (requestJson) {
  var request;
  var beforeRevision;
  var project;
  var sequence;
  try {
    request = JSON.parse(requestJson);
    if (!request || request.protocolVersion !== 1 || typeof request.requestId !== "string" || typeof request.operation !== "string" || typeof request.args !== "object") {
      return PPMCP.failure(request && request.requestId, "CEP_INVALID_REQUEST", "Invalid typed operation envelope", false);
    }
    beforeRevision = PPMCP.simpleRevision();
    if (request.expectedRevision && request.expectedRevision !== beforeRevision) return PPMCP.failure(request.requestId, "CEP_STALE_REVISION", "Project state changed after preview", false);
    project = app.project;
    sequence = project ? project.activeSequence : null;

    if (request.operation === "host.inspect") {
      return PPMCP.success(request, beforeRevision, { hostName: String(app.name || "Premiere Pro"), hostVersion: String(app.version || "unknown"), projectOpen: !!project, sequenceOpen: !!sequence }, "verified", "typed CEP host snapshot");
    }
    if (request.operation === "project.inspect") {
      if (!project) return PPMCP.success(request, beforeRevision, { project: null, sequences: [] }, "verified", "typed CEP project snapshot");
      var sequences = [];
      var sequenceIndex;
      for (sequenceIndex = 0; project.sequences && sequenceIndex < project.sequences.numSequences && sequenceIndex < 256; sequenceIndex++) {
        sequences.push({ id: String(project.sequences[sequenceIndex].sequenceID || ""), name: String(project.sequences[sequenceIndex].name || "") });
      }
      return PPMCP.success(request, beforeRevision, { project: { name: String(project.name || "") }, activeSequenceId: sequence ? String(sequence.sequenceID || "") : null, sequences: sequences }, "verified", "typed CEP project snapshot");
    }
    if (request.operation === "sequence.inspect") {
      if (!sequence) return PPMCP.failure(request.requestId, "CEP_NO_ACTIVE_SEQUENCE", "No active sequence", false);
      return PPMCP.success(request, beforeRevision, { id: String(sequence.sequenceID || ""), name: String(sequence.name || ""), videoTrackCount: sequence.videoTracks.numTracks, audioTrackCount: sequence.audioTracks.numTracks, playheadSeconds: sequence.getPlayerPosition().seconds }, "verified", "typed CEP sequence snapshot");
    }
    if (request.operation === "project.create") {
      if (!request.args.path || typeof request.args.path !== "string") return PPMCP.failure(request.requestId, "CEP_INVALID_PATH", "path is required", false);
      var requestedProjectPath = File(request.args.path).fsName;
      var created = app.newProject(requestedProjectPath);
      var activeProjectPath = app.project ? File(String(app.project.path || "")).fsName : "";
      if (!created || !app.project || String(activeProjectPath).toLowerCase() !== String(requestedProjectPath).toLowerCase()) return PPMCP.failure(request.requestId, "CEP_CREATE_NOT_VERIFIED", "Premiere did not activate the requested new project", false);
      return PPMCP.success(request, beforeRevision, { created: true, pathVerified: true }, "verified", "active project path readback");
    }
    if (request.operation === "project.save") {
      if (!project) return PPMCP.failure(request.requestId, "CEP_NO_ACTIVE_PROJECT", "No active project", false);
      var saved = project.save();
      return PPMCP.success(request, beforeRevision, { saved: saved !== false }, "committed_unverified", "ExtendScript save return; filesystem write not independently verified");
    }
    if (request.operation === "project.save_as") {
      if (!project) return PPMCP.failure(request.requestId, "CEP_NO_ACTIVE_PROJECT", "No active project", false);
      if (!request.args.path || typeof request.args.path !== "string") return PPMCP.failure(request.requestId, "CEP_INVALID_PATH", "path is required", false);
      var requestedSaveAsPath = File(request.args.path).fsName;
      var savedAsFile = File(requestedSaveAsPath);
      if (savedAsFile.exists) return PPMCP.failure(request.requestId, "CEP_SAVE_AS_OUTPUT_EXISTS", "Save As refused to overwrite an existing project file", false);
      var saveAsDispatched = false;
      try {
        saveAsDispatched = true;
        var savedAs = project.saveAs(requestedSaveAsPath);
        var savedAsProject = app.project;
        var activeSaveAsPath = savedAsProject ? File(String(savedAsProject.path || "")).fsName : "";
        if (savedAs === false || !savedAsProject || String(activeSaveAsPath).toLowerCase() !== String(requestedSaveAsPath).toLowerCase() || !savedAsFile.exists || Number(savedAsFile.length || 0) <= 0) return PPMCP.failure(request.requestId, "CEP_SAVE_AS_NOT_VERIFIED", "Premiere did not save and activate the exact requested non-empty project file", false);
        return PPMCP.success(request, beforeRevision, { saved: true, pathVerified: true, bytes: Number(savedAsFile.length), projectPath: activeSaveAsPath }, "verified", "active project path and non-empty project file readback");
      } catch (saveAsError) {
        return PPMCP.failure(request.requestId, saveAsDispatched ? "CEP_SAVE_AS_NOT_VERIFIED" : "CEP_SAVE_AS_FAILED", String(saveAsError), false);
      }
    }
    if (request.operation === "project.checkpoint") {
      var checkpoint = request.args && request.args.checkpoint;
      if (!checkpoint || (checkpoint.phase !== "inspect" && checkpoint.phase !== "save") || typeof checkpoint.planHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(checkpoint.planHash) || request.planHash !== checkpoint.planHash || !request.routeBinding || !checkpoint.routeBinding || checkpoint.routeBinding.backend !== "cep" || request.routeBinding.backend !== checkpoint.routeBinding.backend || String(checkpoint.routeBinding.hostVersion || "") !== String(app.version || "unknown") || String(request.routeBinding.hostVersion || "") !== String(checkpoint.routeBinding.hostVersion || "") || String(request.routeBinding.hostSessionId || "") !== String(checkpoint.routeBinding.hostSessionId || "") || String(request.routeBinding.capabilityFingerprint || "") !== String(checkpoint.routeBinding.capabilityFingerprint || "")) return PPMCP.failure(request.requestId, "CEP_CHECKPOINT_ROUTE_BINDING_INVALID", "Checkpoint requires the exact CEP route binding, phase, and plan hash", false);
      if (!project) return PPMCP.failure(request.requestId, "CEP_NO_ACTIVE_PROJECT", "No active project", false);
      var inspectedCheckpointRawPath = String(project.path || "");
      if (!inspectedCheckpointRawPath) return PPMCP.failure(request.requestId, "CEP_CHECKPOINT_PROJECT_PATH_UNAVAILABLE", "Active project did not provide a path", false);
      var inspectedCheckpointPath = File(inspectedCheckpointRawPath).fsName;
      if (checkpoint.phase === "inspect") return PPMCP.success(request, beforeRevision, { inspected: true, projectPath: inspectedCheckpointPath }, "verified", "active project path readback before checkpoint save");
      if (typeof checkpoint.expectedProjectPath !== "string" || String(File(checkpoint.expectedProjectPath).fsName).toLowerCase() !== String(inspectedCheckpointPath).toLowerCase()) return PPMCP.failure(request.requestId, "CEP_CHECKPOINT_PROJECT_IDENTITY_DRIFT", "Active project changed after checkpoint inspection", false);
      var checkpointSaved = project.save();
      if (checkpointSaved === false) return PPMCP.failure(request.requestId, "CEP_CHECKPOINT_SAVE_NOT_CONFIRMED", "Premiere did not confirm checkpoint save", false);
      var checkpointProject = app.project;
      var checkpointPath = checkpointProject ? File(String(checkpointProject.path || "")).fsName : "";
      if (!checkpointPath) return PPMCP.failure(request.requestId, "CEP_CHECKPOINT_PROJECT_PATH_UNAVAILABLE", "Saved active project did not provide a path", false);
      return PPMCP.success(request, beforeRevision, { saved: true, projectPath: checkpointPath }, "verified", "ExtendScript project.save and active project path readback");
    }
    if (request.operation === "project.open") {
      if (!request.args.path || typeof request.args.path !== "string") return PPMCP.failure(request.requestId, "CEP_INVALID_PATH", "path is required", false);
      var opened = app.openDocument(request.args.path);
      if (!opened || !app.project || String(app.project.path || "").toLowerCase() !== String(request.args.path).toLowerCase()) return PPMCP.failure(request.requestId, "CEP_OPEN_NOT_VERIFIED", "Premiere did not activate the requested project", false);
      return PPMCP.success(request, beforeRevision, { opened: true }, "verified", "active project path readback");
    }
    if (request.operation === "media.import") {
      if (!project || !(request.args.paths instanceof Array) || request.args.paths.length < 1 || request.args.paths.length > 128) return PPMCP.failure(request.requestId, "CEP_INVALID_IMPORT", "A bounded paths array and active project are required", false);
      var beforeCount = project.rootItem.children.numItems;
      var imported = project.importFiles(request.args.paths, true, project.rootItem, false);
      var afterCount = project.rootItem.children.numItems;
      if (!imported || afterCount <= beforeCount) return PPMCP.failure(request.requestId, "CEP_IMPORT_NOT_VERIFIED", "Imported items were not observed", false);
      var importedItems = [];
      var requestedPaths = {};
      var requestedIndex;
      for (requestedIndex = 0; requestedIndex < request.args.paths.length; requestedIndex++) requestedPaths[String(File(request.args.paths[requestedIndex]).fsName).toLowerCase()] = true;
      var itemQueue = [project.rootItem];
      var scannedItems = 0;
      while (itemQueue.length && scannedItems < 5000 && importedItems.length < request.args.paths.length) {
        var parentItem = itemQueue.shift();
        var childIndex;
        for (childIndex = 0; parentItem.children && childIndex < parentItem.children.numItems && scannedItems < 5000; childIndex++) {
          var candidateItem = parentItem.children[childIndex];
          scannedItems++;
          if (candidateItem.children && candidateItem.children.numItems) itemQueue.push(candidateItem);
          try {
            var candidatePath = String(File(candidateItem.getMediaPath()).fsName).toLowerCase();
            if (requestedPaths[candidatePath]) importedItems.push({ nodeId: String(candidateItem.nodeId || ""), name: String(candidateItem.name || ""), pathVerified: true });
          } catch (ignoredMediaPath) {}
        }
      }
      if (importedItems.length < request.args.paths.length) return PPMCP.failure(request.requestId, "CEP_IMPORT_IDENTITY_NOT_VERIFIED", "Imported project-item identities were not read back", false);
      return PPMCP.success(request, beforeRevision, { importedCountLowerBound: afterCount - beforeCount, items: importedItems }, "verified", "project root count and exact media-path identities increased");
    }
    if (request.operation === "timeline.sequence.create_from_media") {
      if (!project || !request.args.name || !(request.args.projectItemIds instanceof Array) || request.args.projectItemIds.length < 1 || request.args.projectItemIds.length > 128) return PPMCP.failure(request.requestId, "CEP_INVALID_SEQUENCE_CREATE", "A name, bounded projectItemIds, and active project are required", false);
      var wantedIds = {};
      var wantedIndex;
      for (wantedIndex = 0; wantedIndex < request.args.projectItemIds.length; wantedIndex++) wantedIds[String(request.args.projectItemIds[wantedIndex])] = true;
      var sequenceItems = [];
      var sequenceQueue = [project.rootItem];
      var sequenceScanned = 0;
      while (sequenceQueue.length && sequenceScanned < 5000 && sequenceItems.length < request.args.projectItemIds.length) {
        var sequenceParent = sequenceQueue.shift();
        var sequenceChildIndex;
        for (sequenceChildIndex = 0; sequenceParent.children && sequenceChildIndex < sequenceParent.children.numItems && sequenceScanned < 5000; sequenceChildIndex++) {
          var sequenceCandidate = sequenceParent.children[sequenceChildIndex];
          sequenceScanned++;
          if (sequenceCandidate.children && sequenceCandidate.children.numItems) sequenceQueue.push(sequenceCandidate);
          if (wantedIds[String(sequenceCandidate.nodeId || "")]) sequenceItems.push(sequenceCandidate);
        }
      }
      if (sequenceItems.length !== request.args.projectItemIds.length) return PPMCP.failure(request.requestId, "CEP_PROJECT_ITEM_NOT_FOUND", "One or more exact project-item identities were not found", false);
      var sequenceCountBefore = project.sequences.numSequences;
      var sequenceCreated = project.createNewSequenceFromClips(String(request.args.name), sequenceItems, project.rootItem);
      var sequenceCountAfter = project.sequences.numSequences;
      var createdSequence = project.activeSequence;
      if (!sequenceCreated || sequenceCountAfter <= sequenceCountBefore || !createdSequence || String(createdSequence.name || "") !== String(request.args.name)) return PPMCP.failure(request.requestId, "CEP_SEQUENCE_CREATE_NOT_VERIFIED", "Sequence count and active sequence identity did not confirm creation", false);
      return PPMCP.success(request, beforeRevision, { created: true, sequenceId: String(createdSequence.sequenceID || ""), name: String(createdSequence.name || ""), sourceItemCount: sequenceItems.length }, "verified", "sequence count and active sequence identity readback");
    }
    if (request.operation === "export.sequence") {
      if (!sequence || !request.args.outputPath || !request.args.presetPath) return PPMCP.failure(request.requestId, "CEP_INVALID_SEQUENCE_EXPORT", "An active sequence, outputPath, and presetPath are required", false);
      var sequenceOutputFile = File(request.args.outputPath);
      var sequencePresetFile = File(request.args.presetPath);
      if (!sequencePresetFile.exists) return PPMCP.failure(request.requestId, "CEP_EXPORT_PRESET_NOT_FOUND", "The approved export preset does not exist", false);
      if (sequenceOutputFile.exists && !request.args.overwrite) return PPMCP.failure(request.requestId, "CEP_EXPORT_OUTPUT_EXISTS", "The output file exists and overwrite is false", false);
      if (sequenceOutputFile.exists && request.args.overwrite && !sequenceOutputFile.remove()) return PPMCP.failure(request.requestId, "CEP_EXPORT_OVERWRITE_FAILED", "The existing approved output could not be removed", false);
      var sequenceExported = sequence.exportAsMediaDirect(sequenceOutputFile.fsName, sequencePresetFile.fsName, 0);
      if (!sequenceExported || !sequenceOutputFile.exists || sequenceOutputFile.length < 1) return PPMCP.failure(request.requestId, "CEP_SEQUENCE_EXPORT_NOT_VERIFIED", "Premiere did not create a non-empty sequence export", false);
      return PPMCP.success(request, beforeRevision, { exported: true, outputPath: sequenceOutputFile.fsName, bytes: sequenceOutputFile.length }, "verified", "non-empty direct sequence export readback");
    }
    if (request.operation === "workspace.set") {
      if (!request.args.name || typeof request.args.name !== "string" || typeof app.setWorkspace !== "function") return PPMCP.failure(request.requestId, "CEP_WORKSPACE_UNAVAILABLE", "Workspace operation is unavailable", false);
      var workspaceChanged = app.setWorkspace(request.args.name);
      return PPMCP.success(request, beforeRevision, { requested: true, hostReturn: workspaceChanged }, "committed_unverified", "Premiere exposes no stable workspace name readback");
    }
    if (request.operation === "timeline.ripple_delete" || request.operation === "timeline.clip.move" || request.operation === "timeline.clip.delete" || request.operation === "timeline.clip.link_group" || request.operation === "effects.apply") {
      if (!sequence) return PPMCP.failure(request.requestId, "CEP_NO_ACTIVE_SEQUENCE", "No active sequence", false);
      var semanticResult;
      try {
        if (request.operation === "timeline.ripple_delete") semanticResult = PPMCP.semantic.rippleDelete(sequence, request.args);
        else if (request.operation === "timeline.clip.move") semanticResult = PPMCP.semantic.clipMove(sequence, request.args);
        else if (request.operation === "timeline.clip.delete") semanticResult = PPMCP.semantic.clipDelete(sequence, request.args);
        else if (request.operation === "timeline.clip.link_group") semanticResult = PPMCP.semantic.linkGroup(sequence, request.args);
        else semanticResult = PPMCP.semantic.applyEffect(sequence, request.args);
      } catch (semanticError) {
        return PPMCP.failure(request.requestId, "CEP_SEMANTIC_FAILED", String(semanticError && semanticError.message ? semanticError.message : semanticError), false);
      }
      return PPMCP.success(request, beforeRevision, semanticResult, "committed_unverified", "typed QE semantic timeline/effects edit with state readback");
    }
    if (request.operation === "timeline.markers" || request.operation === "timeline.in_out" || request.operation === "timeline.playhead") {
      if (!sequence) return PPMCP.failure(request.requestId, "CEP_NO_ACTIVE_SEQUENCE", "No active sequence", false);
      var timelineResult;
      try {
        if (request.operation === "timeline.markers") timelineResult = PPMCP.semantic.markers(sequence, request.args);
        else if (request.operation === "timeline.in_out") timelineResult = PPMCP.semantic.inOut(sequence, request.args);
        else timelineResult = PPMCP.semantic.playhead(sequence, request.args);
      } catch (timelineError) {
        return PPMCP.failure(request.requestId, "CEP_TIMELINE_FAILED", String(timelineError && timelineError.message ? timelineError.message : timelineError), false);
      }
      var timelineOutcome = request.operation === "timeline.in_out" && request.args && request.args.mode === "get" ? "verified" : "committed_unverified";
      return PPMCP.success(request, beforeRevision, timelineResult, timelineOutcome, "typed CEP sequence timeline edit with state readback");
    }
    if (request.operation === "cep.surface.catalog" || request.operation === "qe.catalog") {
      var isQeCatalog = request.operation === "qe.catalog";
      return PPMCP.success(request, beforeRevision, PPMCP.catalogObject(request.args, isQeCatalog), "verified", isQeCatalog ? "bounded QE reflection without getter evaluation" : "bounded ExtendScript reflection without getter evaluation");
    }
    if (/^(cep|qe)\.(read|edit|filesystem|destructive)$/.test(request.operation)) {
      var isQeInvoke = request.operation.indexOf("qe.") === 0;
      return PPMCP.success(request, beforeRevision, PPMCP.invokeCapability(request.operation, request.args, isQeInvoke), request.operation.indexOf(".read") > 0 ? "verified" : "committed_unverified", "opaque host-issued reflection capability");
    }
    return PPMCP.failure(request.requestId, "CEP_OPERATION_UNSUPPORTED", "Operation is not implemented by the typed CEP dispatcher", false);
  } catch (error) {
    return PPMCP.failure(request && request.requestId, "CEP_HOST_EXCEPTION", String(error && error.message ? error.message : error), false);
  }
};

PPMCP.heartbeat = function () {
  var qeAvailable = false;
  try { app.enableQE(); qeAvailable = typeof qe !== "undefined" && !!qe.project; } catch (error) { qeAvailable = false; }
  return JSON.stringify({
    hostVersion: String(app.version || "unknown"),
    capabilities: qeAvailable ? ["typed", "qe"] : ["typed"],
    operations: PPMCP.operations
  });
};
