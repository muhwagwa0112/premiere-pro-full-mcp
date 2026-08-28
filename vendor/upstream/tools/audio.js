import { buildToolScript, escapeForExtendScript } from "../bridge/script-builder.js";
import { sendCommand } from "../bridge/file-bridge.js";
export function getAudioTools(bridgeOptions) {
    return {
        adjust_audio_levels: {
            description: "Adjust the audio level (volume) of a clip in dB",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the audio or video clip",
                    },
                    level_db: {
                        type: "number",
                        description: "Audio level in dB (0 = unity, negative = quieter, positive = louder)",
                    },
                },
                required: ["node_id", "level_db"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var clip = result.clip;
          var volumeComp = __findComp(clip.components, ["Internal Volume", "ADBE Audio Levels", "Volume"], ["Volume", "볼륨"]);
          if (volumeComp) {
            var levelProp = __findProp(volumeComp, ["ADBE Audio Levels", "Level"], ["Level", "레벨"]);
            if (levelProp) {
              // Premiere's internal Audio Levels value is UI dB plus 15.
              // Keep the public contract in dB and prove the write by reading
              // the internal value back from the same property.
              var requestedDb = ${args.level_db};
              var internalLevel = requestedDb + 15;
              levelProp.setValue(internalLevel, true);
              var readInternal = null;
              try { readInternal = levelProp.getValue(0, 0); } catch(e) {}
              return __result({ adjusted: true, clipName: clip.name, requestedLevelDb: requestedDb, levelDb: readInternal === null ? null : Number(readInternal) - 15, internalLevel: readInternal, readbackComplete: readInternal !== null });
            }
          }
          
          return __error("Could not find Volume/Level property on clip");
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        add_audio_keyframes: {
            description: "Add audio level keyframes to create fades or level changes",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    keyframes: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                time_seconds: { type: "number", description: "Time in seconds relative to clip start" },
                                level_db: { type: "number", description: "Audio level in dB" },
                            },
                            required: ["time_seconds", "level_db"],
                        },
                        description: "Array of keyframe objects with time_seconds and level_db",
                    },
                },
                required: ["node_id", "keyframes"],
            },
            handler: async (args) => {
                const keyframeCode = args.keyframes
                    .map((kf) => `
            var kfTime = __secondsToTicks(${kf.time_seconds}).toString();
            levelProp.addKey(kfTime);
            levelProp.setValueAtKey(kfTime, (${kf.level_db} + 15));`)
                    .join("\n");
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var clip = result.clip;
          var volumeComp = __findComp(clip.components, ["Internal Volume", "ADBE Audio Levels", "Volume"], ["Volume", "볼륨"]);
          var levelProp = null;
          if (volumeComp) {
            levelProp = __findProp(volumeComp, ["ADBE Audio Levels", "Level"], ["Level", "레벨"]);
          }
          
          if (!levelProp) return __error("Could not find audio Level property");
          
          levelProp.setTimeVarying(true);
          ${keyframeCode}
          
          var keys = null;
          var readback = [];
          var readbackErrors = [];
          try { keys = levelProp.getKeys() || []; } catch(e) { readbackErrors.push(String(e)); }
          if (keys) for (var k = 0; k < keys.length; k++) {
            var value = null;
            try { value = levelProp.getValueAtKey(keys[k]); } catch(e) { readbackErrors.push(String(e)); }
            readback.push({ timeSeconds: __ticksToSeconds(keys[k].ticks), levelDb: value === null ? null : Number(value) - 15, internalLevel: value });
          }
          return __result({ keyframesAdded: ${args.keyframes.length}, clipName: clip.name, keyframes: readback, readbackComplete: keys !== null && readbackErrors.length === 0, readbackErrors: readbackErrors });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        mute_track: {
            description: "Mute or unmute an audio track",
            parameters: {
                type: "object",
                properties: {
                    track_index: {
                        type: "number",
                        description: "Audio track index (0-based)",
                    },
                    muted: {
                        type: "boolean",
                        description: "True to mute, false to unmute",
                    },
                },
                required: ["track_index", "muted"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          if (${args.track_index} >= seq.audioTracks.numTracks) return __error("Track index out of range");
          
          var track = seq.audioTracks[${args.track_index}];
          track.setMute(${args.muted ? 1 : 0});
          
          return __result({ trackIndex: ${args.track_index}, muted: ${args.muted}, trackName: track.name });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
    };
}
//# sourceMappingURL=audio.js.map
