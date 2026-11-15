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
                const adapter = bridgeOptions?.transport?.audioEdit;
                if (typeof adapter !== "function") return { success: false, code: "AUDIO_PARAMETER_ENCODING_UNKNOWN", error: "This transport must supply a qualified audio valueEncoding adapter" };
                return adapter(args, "scalar");
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
                const adapter = bridgeOptions?.transport?.audioEdit;
                if (typeof adapter !== "function") return { success: false, code: "AUDIO_PARAMETER_ENCODING_UNKNOWN", error: "This transport must supply a qualified audio valueEncoding adapter" };
                return adapter(args, "keyframes");
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
