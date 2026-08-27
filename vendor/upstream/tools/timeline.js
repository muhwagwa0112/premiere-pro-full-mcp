import { buildToolScript, escapeForExtendScript } from "../bridge/script-builder.js";
import { sendCommand } from "../bridge/file-bridge.js";
export function getTimelineTools(bridgeOptions) {
    return {
        add_to_timeline: {
            description: "Add a project item (clip) to the timeline at a specific position",
            parameters: {
                type: "object",
                properties: {
                    item_id: {
                        type: "string",
                        description: "Node ID or name of the project item to add",
                    },
                    track_index: {
                        type: "number",
                        description: "Video track index (0-based, default: 0)",
                    },
                    start_seconds: {
                        type: "number",
                        description: "Start time in seconds on the timeline (default: 0)",
                    },
                    audio_track_index: {
                        type: "number",
                        description: "Audio track index for the audio portion (default: 0)",
                    },
                },
                required: ["item_id"],
            },
            handler: async (args) => {
                const trackIndex = args.track_index ?? 0;
                const startSeconds = args.start_seconds ?? 0;
                const audioTrackIndex = args.audio_track_index ?? 0;
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          var item = __findProjectItem("${escapeForExtendScript(args.item_id)}");
          if (!item) return __error("Project item not found: ${escapeForExtendScript(args.item_id)}");
          
          var startTicks = __secondsToTicks(${startSeconds}).toString();
          seq.insertClip(item, startTicks, ${trackIndex}, ${audioTrackIndex});
          
          return __result({
            added: true,
            item: item.name,
            trackIndex: ${trackIndex},
            startSeconds: ${startSeconds}
          });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        remove_from_timeline: {
            description: "Remove a clip from the timeline",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip to remove",
                    },
                    ripple: {
                        type: "boolean",
                        description: "Whether to ripple delete (close the gap). Default: false",
                    },
                },
                required: ["node_id"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var clip = result.clip;
          clip.remove(${args.ripple ? "true" : "false"}, ${args.ripple ? "true" : "false"});
          return __result({ removed: true, clipName: clip.name });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        move_clip: {
            description: "Move a clip to a new position on the timeline",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip to move",
                    },
                    new_start_seconds: {
                        type: "number",
                        description: "New start time in seconds",
                    },
                    new_track_index: {
                        type: "number",
                        description: "Optional new track index to move the clip to",
                    },
                },
                required: ["node_id", "new_start_seconds"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");

          ${args.new_track_index !== undefined ? `
          // Moving a clip between tracks is not possible in Premiere 26.x
          // CEP/ExtendScript: TrackItem has no moveToTrack/moveTrack/setTrack and
          // QETrackItem.moveToTrack() is unusable. Report it clearly without
          // mutating anything so the clip is left untouched.
          return __error(
            "move_clip: moving a clip to a different track is not supported on Premiere 26.x " +
            "CEP/ExtendScript (there is no working public API). The clip was not moved. " +
            "Use new_start_seconds only to reposition the clip within its current track."
          );
          ` : ""}

          var clip = result.clip;
          var newStartTicks = __secondsToTicks(${args.new_start_seconds}).toString();
          clip.start = newStartTicks;

          return __result({
            moved: true,
            clipName: clip.name,
            newStart: ${args.new_start_seconds}
          });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        trim_clip: {
            description: "Trim a clip's in or out point",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip to trim",
                    },
                    new_in_seconds: {
                        type: "number",
                        description: "New in-point in seconds (relative to clip's source media)",
                    },
                    new_out_seconds: {
                        type: "number",
                        description: "New out-point in seconds (relative to clip's source media)",
                    },
                },
                required: ["node_id"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var clip = result.clip;
          ${args.new_in_seconds !== undefined ? `clip.inPoint = __secondsToTicks(${args.new_in_seconds}).toString();` : ""}
          ${args.new_out_seconds !== undefined ? `clip.outPoint = __secondsToTicks(${args.new_out_seconds}).toString();` : ""}
          
          return __result({
            trimmed: true,
            clipName: clip.name,
            inPoint: __ticksToSeconds(clip.inPoint.ticks),
            outPoint: __ticksToSeconds(clip.outPoint.ticks)
          });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        split_clip: {
            description: "Split (razor) a clip at a specific time position. Requires QE DOM.",
            parameters: {
                type: "object",
                properties: {
                    time_seconds: {
                        type: "number",
                        description: "Time position in seconds where to split",
                    },
                    track_index: {
                        type: "number",
                        description: "Track index (0-based)",
                    },
                    track_type: {
                        type: "string",
                        enum: ["video", "audio"],
                        description: "Track type (default: video)",
                    },
                },
                required: ["time_seconds"],
            },
            handler: async (args) => {
                const trackType = args.track_type || "video";
                const trackIndex = args.track_index ?? 0;
                const script = buildToolScript(`
          app.enableQE();
          var seq = qe.project.getActiveSequence();
          if (!seq) return __error("No active sequence (QE)");
          
          var track = ${trackType === "video" ? `seq.getVideoTrackAt(${trackIndex})` : `seq.getAudioTrackAt(${trackIndex})`};
          if (!track) return __error("Track not found");
          
          var timeTicks = __secondsToTicks(${args.time_seconds}).toString();
          track.razor(timeTicks);
          
          return __result({ split: true, atSeconds: ${args.time_seconds}, trackIndex: ${trackIndex}, trackType: "${trackType}" });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        duplicate_clip: {
            description: "Duplicate a clip on the timeline (copy to same position on next available track)",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip to duplicate",
                    },
                },
                required: ["node_id"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var clip = result.clip;
          var seq = app.project.activeSequence;
          var projectItem = clip.projectItem;
          
          if (!projectItem) return __error("Cannot find source project item for clip");
          
          var newTrackIndex = result.trackIndex + 1;
          var startTicks = clip.start.ticks;
          
          seq.insertClip(projectItem, startTicks, newTrackIndex, newTrackIndex);
          
          return __result({ duplicated: true, clipName: clip.name, newTrackIndex: newTrackIndex });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        enable_disable_clip: {
            description: "Enable or disable a clip on the timeline",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    enabled: {
                        type: "boolean",
                        description: "Set to true to enable, false to disable",
                    },
                },
                required: ["node_id", "enabled"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          // Premiere 26.x CEP/ExtendScript TrackItem has no setDisabled(); the
          // enabled state is set directly via clip.enabled.
          result.clip.enabled = ${args.enabled ? "true" : "false"};
          return __result({ clipName: result.clip.name, enabled: ${args.enabled} });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_clip_properties: {
            description: "Set properties on a clip (opacity, speed, etc.)",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    opacity: {
                        type: "number",
                        description: "Opacity value (0-100)",
                    },
                    speed: {
                        type: "number",
                        description: "Playback speed multiplier (1.0 = normal, 2.0 = double speed)",
                    },
                    scale: {
                        type: "number",
                        description: "Scale percentage (100 = original size)",
                    },
                    position_x: {
                        type: "number",
                        description: "Horizontal position",
                    },
                    position_y: {
                        type: "number",
                        description: "Vertical position",
                    },
                    rotation: {
                        type: "number",
                        description: "Rotation in degrees",
                    },
                },
                required: ["node_id"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var clip = result.clip;
          var changes = {};
          
          ${args.opacity !== undefined ? `
          var opacityComp = __findComp(clip.components, ["AE.ADBE Opacity"], ["Opacity", "불투명도"]);
          if (opacityComp) {
            var opacityProp = __findProp(opacityComp, ["ADBE Opacity", "Opacity"], ["Opacity", "불투명도"]);
            if (opacityProp) {
              opacityProp.setValue(${args.opacity}, true);
              changes.opacity = ${args.opacity};
            }
          }
          ` : ""}
          
          ${args.speed !== undefined ? `
          // Premiere 26.x CEP/ExtendScript: TrackItem.setSpeed() is not a
          // function in this host. Fail honestly rather than reporting a speed
          // change that never happened. Opacity/scale/position/rotation above
          // are still applied and included in changes.
          return __error(
            "set_clip_properties: speed is not supported on Premiere " + app.version +
            " CEP/ExtendScript (TrackItem.setSpeed() is unavailable). " +
            "The other requested properties were applied; set speed via the Premiere UI."
          );
          ` : ""}
          
          ${args.scale !== undefined || args.position_x !== undefined || args.position_y !== undefined || args.rotation !== undefined ? `
          var motion = __findComp(clip.components, ["AE.ADBE Motion"], ["Motion", "모션"]);
          if (motion) {
            ${args.scale !== undefined ? `
            var scaleProp = __findProp(motion, ["ADBE Scale", "Scale"], ["Scale", "비율 조정"]);
            if (scaleProp) { scaleProp.setValue(${args.scale}, true); changes.scale = ${args.scale}; }` : ""}
            ${args.position_x !== undefined || args.position_y !== undefined ? `
            var posProp = __findProp(motion, ["ADBE Position", "Position"], ["Position", "위치"]);
            if (posProp) {
              var posVal = posProp.getValue();
              var px = posVal && typeof posVal === "object" && posVal.length >= 2 ? posVal[0] : 0;
              var py = posVal && typeof posVal === "object" && posVal.length >= 2 ? posVal[1] : 0;
              ${args.position_x !== undefined ? `px = ${args.position_x}; changes.position_x = ${args.position_x};` : ""}
              ${args.position_y !== undefined ? `py = ${args.position_y}; changes.position_y = ${args.position_y};` : ""}
              posProp.setValue([px, py], true);
            }` : ""}
            ${args.rotation !== undefined ? `
            var rotProp = __findProp(motion, ["ADBE Rotation", "Rotation"], ["Rotation", "회전"]);
            if (rotProp) { rotProp.setValue(${args.rotation}, true); changes.rotation = ${args.rotation}; }` : ""}
          }
          ` : ""}
          
          return __result({ updated: true, clipName: clip.name, changes: changes });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        replace_clip: {
            description: "Replace a clip on the timeline with a different project item, preserving position and duration",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip to replace",
                    },
                    new_item_id: {
                        type: "string",
                        description: "Node ID or name of the new project item to replace with",
                    },
                },
                required: ["node_id", "new_item_id"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var newItem = __findProjectItem("${escapeForExtendScript(args.new_item_id)}");
          if (!newItem) return __error("Replacement project item not found: ${escapeForExtendScript(args.new_item_id)}");
          
          var clip = result.clip;
          var oldName = clip.name;
          var startTicks = clip.start.ticks;
          var trackIndex = result.trackIndex;
          var trackType = result.trackType;
          
          // Remove old clip
          clip.remove(false, false);
          
          // Insert new clip at same position
          if (trackType === "video") {
            seq.insertClip(newItem, startTicks, trackIndex, trackIndex);
          } else {
            seq.insertClip(newItem, startTicks, 0, trackIndex);
          }
          
          return __result({
            replaced: true,
            oldClip: oldName,
            newClip: newItem.name,
            trackIndex: trackIndex,
            trackType: trackType
          });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        speed_change: {
            description: "Change the playback speed of a clip",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    speed_percent: {
                        type: "number",
                        description: "Speed as percentage (100 = normal, 200 = double, 50 = half)",
                    },
                    reverse: {
                        type: "boolean",
                        description: "Reverse playback direction (default: false)",
                    },
                },
                required: ["node_id", "speed_percent"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var clip = result.clip;
          var speed = "${args.speed_percent}";
          ${args.reverse ? 'speed = "-" + speed;' : ""}
          
          return __error(
            "speed_change is not supported on Premiere " + app.version +
            " CEP/ExtendScript: TrackItem.setSpeed() is not a function in this host " +
            "(and QETrackItem.setSpeed() throws 'Not Enough Parameters'). " +
            "Change the speed in the Premiere UI (via Clip > Speed/Duration)."
          );
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
    };
}
//# sourceMappingURL=timeline.js.map
