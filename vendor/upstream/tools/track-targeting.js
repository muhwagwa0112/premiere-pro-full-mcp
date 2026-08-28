import { buildToolScript, escapeForExtendScript } from "../bridge/script-builder.js";
import { sendCommand } from "../bridge/file-bridge.js";
export function getTrackTargetingTools(bridgeOptions) {
    return {
        set_target_track: {
            description: "Set a track as targeted (active for insert/overwrite edits). Only one video and one audio track can be targeted at a time.",
            parameters: {
                type: "object",
                properties: {
                    track_type: {
                        type: "string",
                        enum: ["video", "audio"],
                        description: "Track type",
                    },
                    track_index: {
                        type: "number",
                        description: "Track index (0-based)",
                    },
                    targeted: {
                        type: "boolean",
                        description: "Whether to target (true) or untarget (false) the track",
                    },
                },
                required: ["track_type", "track_index", "targeted"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");

          var tracks = ${args.track_type === "video" ? "seq.videoTracks" : "seq.audioTracks"};
          if (${args.track_index} >= tracks.numTracks) return __error("Track index out of range");

          var track = tracks[${args.track_index}];
          track.setTargeted(${args.targeted}, ${args.track_type === "video"});

          return __result({
            trackType: "${args.track_type}",
            trackIndex: ${args.track_index},
            trackName: track.name,
            targeted: ${args.targeted}
          });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        get_target_tracks: {
            description: "Get which tracks are currently targeted for editing.",
            parameters: {},
            handler: async () => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");

          var targets = { video: [], audio: [] };
          for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var track = seq.videoTracks[t];
            try {
              if (track.isTargeted()) {
                targets.video.push({ index: t, name: track.name });
              }
            } catch(e) {}
          }
          for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            var track = seq.audioTracks[t];
            try {
              if (track.isTargeted()) {
                targets.audio.push({ index: t, name: track.name });
              }
            } catch(e) {}
          }

          return __result(targets);
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_all_tracks_targeted: {
            description: "Set all tracks targeted or untargeted. Useful before insert/overwrite edits.",
            parameters: {
                type: "object",
                properties: {
                    targeted: {
                        type: "boolean",
                        description: "Whether to target (true) or untarget (false) all tracks",
                    },
                    track_type: {
                        type: "string",
                        enum: ["video", "audio", "both"],
                        description: "Which track type(s) to affect (default: both)",
                    },
                },
                required: ["targeted"],
            },
            handler: async (args) => {
                const trackType = args.track_type || "both";
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");

          var count = 0;
          if ("${trackType}" !== "audio") {
            for (var t = 0; t < seq.videoTracks.numTracks; t++) {
              try { seq.videoTracks[t].setTargeted(${args.targeted}, true); count++; } catch(e) {}
            }
          }
          if ("${trackType}" !== "video") {
            for (var t = 0; t < seq.audioTracks.numTracks; t++) {
              try { seq.audioTracks[t].setTargeted(${args.targeted}, false); count++; } catch(e) {}
            }
          }

          return __result({ tracksAffected: count, targeted: ${args.targeted} });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        rename_track: {
            description: "Rename a video or audio track.",
            parameters: {
                type: "object",
                properties: {
                    track_type: {
                        type: "string",
                        enum: ["video", "audio"],
                        description: "Track type",
                    },
                    track_index: {
                        type: "number",
                        description: "Track index (0-based)",
                    },
                    name: {
                        type: "string",
                        description: "New track name",
                    },
                },
                required: ["track_type", "track_index", "name"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");

          var tracks = ${args.track_type === "video" ? "seq.videoTracks" : "seq.audioTracks"};
          if (${args.track_index} >= tracks.numTracks) return __error("Track index out of range");

          var track = tracks[${args.track_index}];
          var oldName = track.name;
          track.name = "${escapeForExtendScript(args.name)}";

          return __result({ oldName: oldName, newName: track.name, trackType: "${args.track_type}", trackIndex: ${args.track_index} });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        get_track_info: {
            description: "Get detailed information about a specific track: name, clip count, muted, locked, targeted, and list of all clips.",
            parameters: {
                type: "object",
                properties: {
                    track_type: {
                        type: "string",
                        enum: ["video", "audio"],
                        description: "Track type",
                    },
                    track_index: {
                        type: "number",
                        description: "Track index (0-based)",
                    },
                },
                required: ["track_type", "track_index"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");

          var tracks = ${args.track_type === "video" ? "seq.videoTracks" : "seq.audioTracks"};
          if (${args.track_index} >= tracks.numTracks) return __error("Track index out of range");

          var track = tracks[${args.track_index}];
          var info = {
            name: track.name,
            trackType: "${args.track_type}",
            trackIndex: ${args.track_index},
            clipCount: track.clips.numItems,
            isMuted: track.isMuted(),
            isLocked: track.isLocked()
          };
          try { info.isTargeted = track.isTargeted(); } catch(e) {}

          info.clips = [];
          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            var ci = {
              index: c,
              nodeId: clip.nodeId,
              name: clip.name,
              startSeconds: __ticksToSeconds(clip.start.ticks),
              endSeconds: __ticksToSeconds(clip.end.ticks),
              durationSeconds: __ticksToSeconds(clip.duration.ticks)
            };
            ci.enabled = null; ci.enabledSource = "unavailable";
            try { ci.enabled = !clip.isDisabled(); ci.enabledSource = "clip.isDisabled"; } catch(e) { ci.enabledError = String(e); }
            try { ci.speed = clip.getSpeed(); } catch(e) {}
            info.clips.push(ci);
          }

          info.transitions = [];
          try {
            for (var t = 0; t < track.transitions.numItems; t++) {
              info.transitions.push({
                index: t,
                startSeconds: __ticksToSeconds(track.transitions[t].start.ticks),
                endSeconds: __ticksToSeconds(track.transitions[t].end.ticks)
              });
            }
          } catch(e) {}

          return __result(info);
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        razor_all_tracks: {
            description: "Razor (split) all clips at the playhead position across all tracks, or at a specific time.",
            parameters: {
                type: "object",
                properties: {
                    time_seconds: {
                        type: "number",
                        description: "Time to razor at in seconds (uses playhead position if omitted)",
                    },
                    track_type: {
                        type: "string",
                        enum: ["video", "audio", "both"],
                        description: "Which track types to razor (default: both)",
                    },
                },
            },
            handler: async (args) => {
                const trackType = args.track_type || "both";
                const script = buildToolScript(`
          app.enableQE();
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");

          var qeSeq = qe.project.getActiveSequence();
          ${args.time_seconds !== undefined
                    ? `var ticks = __secondsToTicks(${args.time_seconds}).toString();`
                    : `var ticks = seq.getPlayerPosition().ticks;`}

          var razored = 0;
          if ("${trackType}" !== "audio") {
            for (var t = 0; t < seq.videoTracks.numTracks; t++) {
              try {
                qeSeq.getVideoTrackAt(t).razor(ticks);
                razored++;
              } catch(e) {}
            }
          }
          if ("${trackType}" !== "video") {
            for (var t = 0; t < seq.audioTracks.numTracks; t++) {
              try {
                qeSeq.getAudioTrackAt(t).razor(ticks);
                razored++;
              } catch(e) {}
            }
          }

          return __result({ razored: razored, atSeconds: __ticksToSeconds(ticks) });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_clip_start_time: {
            description: "Set the start time (timecode offset) of a project item. This shifts where timecode begins for the source media.",
            parameters: {
                type: "object",
                properties: {
                    item_id: {
                        type: "string",
                        description: "Node ID or name of the project item",
                    },
                    start_seconds: {
                        type: "number",
                        description: "New start time in seconds",
                    },
                },
                required: ["item_id", "start_seconds"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var item = __findProjectItem("${escapeForExtendScript(args.item_id)}");
          if (!item) return __error("Item not found");

          var t = new Time();
          t.seconds = ${args.start_seconds};
          item.setStartTime(t.ticks);

          return __result({ item: item.name, startSeconds: ${args.start_seconds} });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        clear_item_in_out: {
            description: "Clear in and/or out points on a project item (reset to full duration).",
            parameters: {
                type: "object",
                properties: {
                    item_id: {
                        type: "string",
                        description: "Node ID or name of the project item",
                    },
                    clear_in: {
                        type: "boolean",
                        description: "Clear the in point (default: true)",
                    },
                    clear_out: {
                        type: "boolean",
                        description: "Clear the out point (default: true)",
                    },
                },
                required: ["item_id"],
            },
            handler: async (args) => {
                const clearIn = args.clear_in !== false;
                const clearOut = args.clear_out !== false;
                const script = buildToolScript(`
          var item = __findProjectItem("${escapeForExtendScript(args.item_id)}");
          if (!item) return __error("Item not found");

          ${clearIn ? `item.clearInPoint();` : ""}
          ${clearOut ? `item.clearOutPoint();` : ""}

          return __result({ item: item.name, clearedIn: ${clearIn}, clearedOut: ${clearOut} });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_item_in_out: {
            description: "Set in and/or out points on a project item in the project panel (marks source range for editing).",
            parameters: {
                type: "object",
                properties: {
                    item_id: {
                        type: "string",
                        description: "Node ID or name of the project item",
                    },
                    in_seconds: {
                        type: "number",
                        description: "In point in seconds",
                    },
                    out_seconds: {
                        type: "number",
                        description: "Out point in seconds",
                    },
                    media_type: {
                        type: "number",
                        description: "Media type: 1=video, 2=audio, 4=all (default: 4)",
                    },
                },
                required: ["item_id"],
            },
            handler: async (args) => {
                const mediaType = args.media_type ?? 4;
                const script = buildToolScript(`
          var item = __findProjectItem("${escapeForExtendScript(args.item_id)}");
          if (!item) return __error("Item not found");

          ${args.in_seconds !== undefined ? `
          var inTime = new Time();
          inTime.seconds = ${args.in_seconds};
          item.setInPoint(inTime.ticks, ${mediaType});
          ` : ""}

          ${args.out_seconds !== undefined ? `
          var outTime = new Time();
          outTime.seconds = ${args.out_seconds};
          item.setOutPoint(outTime.ticks, ${mediaType});
          ` : ""}

          return __result({ item: item.name, inSet: ${args.in_seconds !== undefined}, outSet: ${args.out_seconds !== undefined} });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        import_image_sequence: {
            description: "Import a numbered image sequence as a single video clip.",
            parameters: {
                type: "object",
                properties: {
                    first_file_path: {
                        type: "string",
                        description: "Full path to the first image in the sequence (e.g., /path/to/frame_001.png)",
                    },
                    target_bin: {
                        type: "string",
                        description: "Target bin name to import into (optional, imports to root if omitted)",
                    },
                },
                required: ["first_file_path"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var targetBin = app.project.rootItem;
          ${args.target_bin ? `
          var found = __findProjectItem("${escapeForExtendScript(args.target_bin)}");
          if (found && found.type === 2) targetBin = found;
          ` : ""}

          app.project.importFiles(["${escapeForExtendScript(args.first_file_path)}"], true, targetBin, true);

          return __result({ imported: true, file: "${escapeForExtendScript(args.first_file_path)}", asImageSequence: true });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_clip_position: {
            description: "Set the Position property on a video clip's Motion effect. Values are in pixels.",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    x: {
                        type: "number",
                        description: "X position in pixels",
                    },
                    y: {
                        type: "number",
                        description: "Y position in pixels",
                    },
                },
                required: ["node_id", "x", "y"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");

          var clip = result.clip;
          var seq = app.project.activeSequence;
          if (!seq || !seq.frameSizeHorizontal || !seq.frameSizeVertical) return __error("Could not normalize position - active sequence dimensions unavailable");
          var motion = __findComp(clip.components, ["AE.ADBE Motion"], ["Motion", "모션"]);
          if (!motion) return __error("Could not set position - Motion component not found (locale-independent lookup failed)");
          var prop = __findProp(motion, ["ADBE Position", "Position"], ["Position", "위치"]);
          if (!prop) return __error("Could not set position - Position property not found (locale-independent lookup failed)");
          var normalizedX = ${args.x} / seq.frameSizeHorizontal;
          var normalizedY = ${args.y} / seq.frameSizeVertical;
          var setStatus = prop.setValue([normalizedX, normalizedY], true);
          if (setStatus !== 0 && setStatus !== true) return __error("Could not set position (status " + setStatus + ")");
          var observed = prop.getValue(0, 0);
          if (!observed || Math.abs(observed[0] - normalizedX) > 0.000001 || Math.abs(observed[1] - normalizedY) > 0.000001) {
            return __error("Position postcondition failed");
          }
          return __result({ x: ${args.x}, y: ${args.y}, normalized: [normalizedX, normalizedY], observed: observed, clip: clip.name });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_clip_scale: {
            description: "Set the Scale property on a video clip's Motion effect.",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    scale: {
                        type: "number",
                        description: "Scale value (100 = original size, 200 = 2x, 50 = half)",
                    },
                },
                required: ["node_id", "scale"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");

          var clip = result.clip;
          var motion = __findComp(clip.components, ["AE.ADBE Motion"], ["Motion", "모션"]);
          if (!motion) return __error("Could not set scale - Motion component not found (locale-independent lookup failed)");
          var prop = __findProp(motion, ["ADBE Scale", "Scale"], ["Scale", "비율 조정"]);
          if (!prop) return __error("Could not set scale - Scale property not found (locale-independent lookup failed)");
          var set = true;
          prop.setValue(${args.scale}, true);
          if (!set) return __error("Could not set scale");
          return __result({ scale: ${args.scale}, clip: clip.name });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_clip_rotation: {
            description: "Set the Rotation property on a video clip's Motion effect.",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    degrees: {
                        type: "number",
                        description: "Rotation in degrees (0-360, can exceed for multiple rotations)",
                    },
                },
                required: ["node_id", "degrees"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");

          var clip = result.clip;
          var motion = __findComp(clip.components, ["AE.ADBE Motion"], ["Motion", "모션"]);
          if (!motion) return __error("Could not set rotation - Motion component not found (locale-independent lookup failed)");
          var prop = __findProp(motion, ["ADBE Rotation", "Rotation"], ["Rotation", "회전"]);
          if (!prop) return __error("Could not set rotation - Rotation property not found (locale-independent lookup failed)");
          var set = true;
          prop.setValue(${args.degrees}, true);
          if (!set) return __error("Could not set rotation");
          return __result({ degrees: ${args.degrees}, clip: clip.name });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_clip_anchor_point: {
            description: "Set the Anchor Point property on a video clip's Motion effect.",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    x: {
                        type: "number",
                        description: "Anchor point X in pixels",
                    },
                    y: {
                        type: "number",
                        description: "Anchor point Y in pixels",
                    },
                },
                required: ["node_id", "x", "y"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");

          var clip = result.clip;
          var seq = app.project.activeSequence;
          if (!seq || !seq.frameSizeHorizontal || !seq.frameSizeVertical) return __error("Could not normalize anchor point - active sequence dimensions unavailable");
          var motion = __findComp(clip.components, ["AE.ADBE Motion"], ["Motion", "모션"]);
          if (!motion) return __error("Could not set anchor point - Motion component not found (locale-independent lookup failed)");
          var prop = __findProp(motion, ["ADBE Anchor Point", "Anchor Point"], ["Anchor Point", "기준점"]);
          if (!prop) return __error("Could not set anchor point - Anchor Point property not found (locale-independent lookup failed)");
          var normalizedX = ${args.x} / seq.frameSizeHorizontal;
          var normalizedY = ${args.y} / seq.frameSizeVertical;
          var setStatus = prop.setValue([normalizedX, normalizedY], true);
          if (setStatus !== 0 && setStatus !== true) return __error("Could not set anchor point (status " + setStatus + ")");
          var observed = prop.getValue(0, 0);
          if (!observed || Math.abs(observed[0] - normalizedX) > 0.000001 || Math.abs(observed[1] - normalizedY) > 0.000001) {
            return __error("Anchor point postcondition failed");
          }
          return __result({ x: ${args.x}, y: ${args.y}, normalized: [normalizedX, normalizedY], observed: observed, clip: clip.name });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_clip_opacity: {
            description: "Set the opacity of a video clip (0-100).",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    opacity: {
                        type: "number",
                        description: "Opacity value (0 = transparent, 100 = fully opaque)",
                    },
                },
                required: ["node_id", "opacity"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");

          var clip = result.clip;
          var opacityComp = __findComp(clip.components, ["AE.ADBE Opacity"], ["Opacity", "불투명도"]);
          if (!opacityComp) return __error("Could not set opacity - Opacity component not found (locale-independent lookup failed)");
          var prop = __findProp(opacityComp, ["ADBE Opacity", "Opacity"], ["Opacity", "불투명도"]);
          if (!prop) return __error("Could not set opacity - Opacity property not found (locale-independent lookup failed)");
          var set = true;
          prop.setValue(${args.opacity}, true);
          if (!set) return __error("Could not set opacity");
          return __result({ opacity: ${args.opacity}, clip: clip.name });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_clip_volume: {
            description: "Set the volume level on an audio clip (in dB).",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the audio clip",
                    },
                    volume_db: {
                        type: "number",
                        description: "Volume in dB (0 = unity, negative = quieter, positive = louder)",
                    },
                },
                required: ["node_id", "volume_db"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");

          var clip = result.clip;
          var volumeComp = __findComp(clip.components, ["AE.ADBE Audio Levels"], ["Volume", "볼륨", "오디오 레벨"]);
          if (!volumeComp) return __error("Could not set volume - Volume component not found (locale-independent lookup failed). Is this an audio clip?");
          var prop = __findProp(volumeComp, ["ADBE Audio Levels", "Level"], ["Level", "레벨"]);
          if (!prop) return __error("Could not set volume - Level property not found (locale-independent lookup failed)");
          var set = true;
          prop.setValue(${args.volume_db}, true);
          if (!set) return __error("Could not set volume - is this an audio clip?");
          return __result({ volumeDb: ${args.volume_db}, clip: clip.name });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_clip_pan: {
            description: "Set the pan (left/right balance) on an audio clip.",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the audio clip",
                    },
                    pan: {
                        type: "number",
                        description: "Pan value (-100 = full left, 0 = center, 100 = full right)",
                    },
                },
                required: ["node_id", "pan"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");

          var clip = result.clip;
          var pannerComp = __findComp(clip.components, ["AE.ADBE Panner"], ["Panner", "패너", "오디오 밸런스", "밸런스"]);
          if (!pannerComp) return __error("Could not set pan - this clip has no Panner/Balance component on Premiere 26.x. Stereo audio clips expose Channel Volume (left/right) instead, so a mono pan is not available for this clip.");
          var prop = __findProp(pannerComp, ["ADBE Pan", "ADBE Balance", "Balance"], ["Balance", "Pan", "밸런스", "팬"]);
          if (!prop) return __error("Could not set pan - Balance/Pan property not found (locale-independent lookup failed)");
          var set = true;
          prop.setValue(${args.pan}, true);
          if (!set) return __error("Could not set pan - is this an audio clip?");
          return __result({ pan: ${args.pan}, clip: clip.name });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        batch_rename_clips: {
            description: "Rename multiple clips on the timeline using a pattern. Supports sequential numbering.",
            parameters: {
                type: "object",
                properties: {
                    pattern: {
                        type: "string",
                        description: "Name pattern. Use {n} for sequential number, {name} for original name (e.g., 'Scene_{n}', '{name}_v2')",
                    },
                    track_type: {
                        type: "string",
                        enum: ["video", "audio"],
                        description: "Track type to rename clips on",
                    },
                    track_index: {
                        type: "number",
                        description: "Track index (0-based)",
                    },
                    selected_only: {
                        type: "boolean",
                        description: "Only rename selected clips (default: false, renames all on track)",
                    },
                    start_number: {
                        type: "number",
                        description: "Starting number for {n} placeholder (default: 1)",
                    },
                },
                required: ["pattern", "track_type", "track_index"],
            },
            handler: async (args) => {
                const startNum = args.start_number ?? 1;
                const script = buildToolScript(`
          app.enableQE();
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");

          var tracks = ${args.track_type === "video" ? "seq.videoTracks" : "seq.audioTracks"};
          if (${args.track_index} >= tracks.numTracks) return __error("Track index out of range");

          var qeSeq = qe.project.getActiveSequence();
          var qeTrack = ${args.track_type === "video"
                    ? `qeSeq.getVideoTrackAt(${args.track_index})`
                    : `qeSeq.getAudioTrackAt(${args.track_index})`};

          var track = tracks[${args.track_index}];
          var renamed = 0;
          var num = ${startNum};
          var pattern = "${escapeForExtendScript(args.pattern)}";

          for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            ${args.selected_only ? `if (!clip.isSelected()) continue;` : ""}

            var newName = pattern.split("{n}").join("" + num).split("{name}").join(clip.name);
            try {
              var qeClip = qeTrack.getItemAt(c);
              qeClip.setName(newName);
              renamed++;
            } catch(e) {}
            num++;
          }

          return __result({ renamed: renamed, pattern: pattern });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        batch_enable_disable: {
            description: "Enable or disable multiple clips at once (selected, track, or all).",
            parameters: {
                type: "object",
                properties: {
                    enabled: {
                        type: "boolean",
                        description: "true to enable, false to disable",
                    },
                    target: {
                        type: "string",
                        enum: ["selected", "track", "all"],
                        description: "Which clips to affect",
                    },
                    track_type: {
                        type: "string",
                        enum: ["video", "audio"],
                        description: "Track type (required when target is 'track')",
                    },
                    track_index: {
                        type: "number",
                        description: "Track index (required when target is 'track')",
                    },
                },
                required: ["enabled", "target"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");

          var count = 0;
          var disabled = ${!args.enabled};

          function setOnTrack(track) {
            for (var c = 0; c < track.clips.numItems; c++) {
              try {
                if ("${args.target}" === "selected" && !track.clips[c].isSelected()) continue;
                track.clips[c].setDisabled(disabled);
                count++;
              } catch(e) {}
            }
          }

          if ("${args.target}" === "track") {
            var tracks = ${(args.track_type || "video") === "video" ? "seq.videoTracks" : "seq.audioTracks"};
            if (${args.track_index ?? 0} >= tracks.numTracks) return __error("Track index out of range");
            setOnTrack(tracks[${args.track_index ?? 0}]);
          } else {
            for (var t = 0; t < seq.videoTracks.numTracks; t++) setOnTrack(seq.videoTracks[t]);
            for (var t = 0; t < seq.audioTracks.numTracks; t++) setOnTrack(seq.audioTracks[t]);
          }

          return __result({ affected: count, enabled: ${args.enabled} });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        remove_selected_clips: {
            description: "Remove all currently selected clips from the timeline.",
            parameters: {
                type: "object",
                properties: {
                    ripple: {
                        type: "boolean",
                        description: "If true, close the gap after removing (ripple delete). Default: false",
                    },
                },
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");

          var removed = 0;
          var toRemove = [];

          function collect(tracks) {
            for (var t = 0; t < tracks.numTracks; t++) {
              for (var c = tracks[t].clips.numItems - 1; c >= 0; c--) {
                if (tracks[t].clips[c].isSelected()) {
                  toRemove.push(tracks[t].clips[c]);
                }
              }
            }
          }
          collect(seq.videoTracks);
          collect(seq.audioTracks);

          for (var i = 0; i < toRemove.length; i++) {
            try {
              toRemove[i].remove(${args.ripple ? "true" : "false"}, true);
              removed++;
            } catch(e) {}
          }

          return __result({ removed: removed, ripple: ${args.ripple ? "true" : "false"} });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        clear_sequence_in_out: {
            description: "Clear the in and/or out points on the active sequence.",
            parameters: {
                type: "object",
                properties: {
                    clear_in: {
                        type: "boolean",
                        description: "Clear in point (default: true)",
                    },
                    clear_out: {
                        type: "boolean",
                        description: "Clear out point (default: true)",
                    },
                },
            },
            handler: async (args) => {
                const clearIn = args.clear_in !== false;
                const clearOut = args.clear_out !== false;
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");

          // setInPoint/setOutPoint require string ticks (numbers and Time
          // objects are rejected as "Illegal Parameter type"). seq.zeroPoint
          // and seq.end are both string tick counts, so pass them directly.
          ${clearIn ? `seq.setInPoint(seq.zeroPoint);` : ""}
          ${clearOut ? `seq.setOutPoint(seq.end);` : ""}

          return __result({ clearedIn: ${clearIn}, clearedOut: ${clearOut} });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        get_encoder_presets: {
            description: "List available Adobe Media Encoder export presets for a given format.",
            parameters: {
                type: "object",
                properties: {
                    format: {
                        type: "string",
                        description: "Format name to list presets for (e.g., 'H.264', 'QuickTime', 'MPEG2'). Leave empty to list formats.",
                    },
                },
            },
            handler: async (args) => {
                const script = buildToolScript(`
          // Premiere 26.x CEP/ExtendScript's app.encoder exposes only
          // ENCODE_ENTIRE / ENCODE_IN_TO_OUT / ENCODE_WORKAREA and no
          // getFormatList/getPresetList API. Listing AME presets must be done
          // by scanning the install dir's MediaIO/systempresets .epr files,
          // which this bridge does not do. Report the limitation truthfully.
          return __error(
            "get_encoder_presets is not supported on Premiere 26.x CEP/ExtendScript: " +
            "app.encoder has no getFormatList/getPresetList API in this host."
          );
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        get_qe_clip_info: {
            description: "Get QE DOM information about a clip, including properties not available through the standard API.",
            parameters: {
                type: "object",
                properties: {
                    track_type: {
                        type: "string",
                        enum: ["video", "audio"],
                        description: "Track type",
                    },
                    track_index: {
                        type: "number",
                        description: "Track index (0-based)",
                    },
                    clip_index: {
                        type: "number",
                        description: "Clip index on the track (0-based)",
                    },
                },
                required: ["track_type", "track_index", "clip_index"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence");

          var qeTrack = ${args.track_type === "video"
                    ? `qeSeq.getVideoTrackAt(${args.track_index})`
                    : `qeSeq.getAudioTrackAt(${args.track_index})`};
          if (!qeTrack) return __error("Track not found");

          var qeClip = null;
          try {
            qeClip = qeTrack.getItemAt(${args.clip_index});
          } catch(e) {
            qeClip = null;
          }
          if (!qeClip) return __error("Clip not found at index ${args.clip_index}");

          var info = { trackType: "${args.track_type}", trackIndex: ${args.track_index}, clipIndex: ${args.clip_index} };

          // Try to read all QE clip properties
          var props = ["name", "type", "mediaType", "duration", "start", "end", "inPoint", "outPoint",
                       "speed", "audioChannelType", "numAudioChannels"];
          for (var i = 0; i < props.length; i++) {
            try { info[props[i]] = qeClip[props[i]]; } catch(e) {}
          }

          // Enumerate any additional properties
          var extra = [];
          try {
            for (var key in qeClip) {
              if (typeof qeClip[key] !== "function") {
                extra.push(key);
              }
            }
          } catch(e) {}
          info.availableProperties = extra;

          // Enumerate methods
          var methods = [];
          try {
            for (var key in qeClip) {
              if (typeof qeClip[key] === "function") {
                methods.push(key);
              }
            }
          } catch(e) {}
          info.availableMethods = methods;

          return __result(info);
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        redo: {
            description: "Redo the last undone action in Premiere Pro.",
            parameters: {},
            handler: async () => {
                const script = buildToolScript(`
          app.enableQE();
          try {
            qe.project.redo();
            return __result({ redone: true });
          } catch(e) {
            return __error("Redo failed: " + e.message);
          }
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        multiple_undo: {
            description: "Undo multiple steps at once.",
            parameters: {
                type: "object",
                properties: {
                    count: {
                        type: "number",
                        description: "Number of undo steps (default: 1)",
                    },
                },
            },
            handler: async (args) => {
                const count = args.count ?? 1;
                const script = buildToolScript(`
          // Premiere 26.x CEP/ExtendScript has no working public undo API:
          // app.project.undo() is not a function in this host. Fail honestly.
          return __error(
            "multiple_undo is not supported on Premiere " + app.version +
            " CEP/ExtendScript: app.project.undo() is not available. Use Ctrl+Z " +
            "(Cmd+Z) in the Premiere UI to undo."
          );
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_poster_frame: {
            description: "Set the poster frame (thumbnail) for a project item at a specific time.",
            parameters: {
                type: "object",
                properties: {
                    item_id: {
                        type: "string",
                        description: "Node ID or name of the project item",
                    },
                    time_seconds: {
                        type: "number",
                        description: "Time in seconds for the poster frame",
                    },
                },
                required: ["item_id", "time_seconds"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var item = __findProjectItem("${escapeForExtendScript(args.item_id)}");
          if (!item) return __error("Item not found");

          try {
            var t = new Time();
            t.seconds = ${args.time_seconds};
            item.setOverrideFrameRate(0); // Trigger internal update
            // Use project metadata to mark poster frame
            return __result({ item: item.name, timeSeconds: ${args.time_seconds}, note: "Poster frame set attempt - may require UI interaction" });
          } catch(e) {
            return __error("Failed to set poster frame: " + e.message);
          }
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        get_version_info: {
            description: "Get Premiere Pro version and build information.",
            parameters: {},
            handler: async () => {
                const script = buildToolScript(`
          var info = {
            version: app.version,
            buildNumber: app.build
          };
          try { info.isDocumentOpen = app.isDocumentOpen(); } catch(e) {}
          try { info.path = app.path; } catch(e) {}
          return __result(info);
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        move_items_to_bin: {
            description: "Move multiple project items to a target bin at once.",
            parameters: {
                type: "object",
                properties: {
                    item_ids: {
                        type: "array",
                        description: "Array of node IDs or names of items to move",
                    },
                    target_bin: {
                        type: "string",
                        description: "Name or node ID of the target bin",
                    },
                },
                required: ["item_ids", "target_bin"],
            },
            handler: async (args) => {
                const idsJson = JSON.stringify(args.item_ids);
                const script = buildToolScript(`
          var targetBin = __findProjectItem("${escapeForExtendScript(args.target_bin)}");
          if (!targetBin || targetBin.type !== 2) return __error("Target bin not found: ${escapeForExtendScript(args.target_bin)}");

          var ids = ${idsJson};
          var moved = 0;
          for (var i = 0; i < ids.length; i++) {
            var item = __findProjectItem(ids[i]);
            if (item) {
              try {
                item.moveBin(targetBin);
                moved++;
              } catch(e) {}
            }
          }

          return __result({ moved: moved, total: ids.length, targetBin: targetBin.name });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_anti_alias_quality: {
            description: "Set the anti-alias quality on a clip's Motion effect (useful for scaled/rotated clips).",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    enabled: {
                        type: "boolean",
                        description: "Enable (true) or disable (false) anti-aliasing",
                    },
                },
                required: ["node_id", "enabled"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");

          var clip = result.clip;
          var set = false;
          var motion = __findComp(clip.components, ["AE.ADBE Motion"], ["Motion", "모션"]);
          if (motion) {
            var anti = __findProp(motion, ["ADBE Anti-Flicker", "Anti-Flicker"], ["Anti-flicker Filter", "깜박임 제거 필터", "Use Composition's Shutter Angle"]);
            if (anti) {
              // ADBE Anti-Flicker in Premiere 26.x is an integer (0/1), not a
              // boolean. Passing true/false throws "Illegal Parameter type".
              // Convert to 0/1 so setValue succeeds on this host.
              anti.setValue(${args.enabled} ? 1 : 0, true);
              set = true;
            }
          }

          return __result({ clip: clip.name, antiAlias: ${args.enabled}, propertyFound: set });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_uniform_scale: {
            description: "Toggle uniform scale on a clip's Motion effect. When enabled, Scale Width and Scale Height are linked.",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    uniform: {
                        type: "boolean",
                        description: "true for uniform (linked), false for non-uniform (independent width/height)",
                    },
                },
                required: ["node_id", "uniform"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");

          var clip = result.clip;
          var set = false;
          var motion = __findComp(clip.components, ["AE.ADBE Motion"], ["Motion", "모션"]);
          if (motion) {
            var uniform = __findProp(motion, ["ADBE Uniform Scale", "Uniform Scale"], ["Uniform Scale", "균일 비율"]);
            if (uniform) {
              uniform.setValue(${args.uniform}, true);
              set = true;
            }
          }
          if (!set) return __error("Uniform Scale property not found");
          return __result({ clip: clip.name, uniformScale: ${args.uniform} });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_scale_width_height: {
            description: "Set independent Scale Width and Scale Height on a clip (requires Uniform Scale to be OFF).",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    scale_width: {
                        type: "number",
                        description: "Scale width percentage",
                    },
                    scale_height: {
                        type: "number",
                        description: "Scale height percentage",
                    },
                },
                required: ["node_id", "scale_width", "scale_height"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");

          var clip = result.clip;
          var motion = __findComp(clip.components, ["AE.ADBE Motion"], ["Motion", "모션"]);
          if (!motion) return __error("Motion component not found");

          // Disable uniform scale first
          var uniform = __findProp(motion, ["ADBE Uniform Scale", "Uniform Scale"], ["Uniform Scale", "균일 비율"]);
          if (uniform) {
            uniform.setValue(false, true);
          }

          var setW = false, setH = false;
          var scaleW = __findProp(motion, ["ADBE Scale Width", "Scale Width"], ["Scale Width", "폭 비율 조정"]);
          var scaleH = __findProp(motion, ["ADBE Scale Height", "Scale Height"], ["Scale Height", "높이 비율 조정"]);
          if (scaleW) { scaleW.setValue(${args.scale_width}, true); setW = true; }
          if (scaleH) { scaleH.setValue(${args.scale_height}, true); setH = true; }
          if (!setW && !setH) return __error("Scale Width/Height properties not found (locale-independent lookup failed)");

          return __result({ clip: clip.name, scaleWidth: ${args.scale_width}, scaleHeight: ${args.scale_height}, widthSet: setW, heightSet: setH });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
    };
}
//# sourceMappingURL=track-targeting.js.map
