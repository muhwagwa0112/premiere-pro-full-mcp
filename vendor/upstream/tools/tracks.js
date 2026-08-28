import { buildToolScript, escapeForExtendScript } from "../bridge/script-builder.js";
import { sendCommand } from "../bridge/file-bridge.js";
export function getTrackTools(bridgeOptions) {
    return {
        add_track: {
            description: "Add a new video or audio track to the active sequence",
            parameters: {
                type: "object",
                properties: {
                    track_type: {
                        type: "string",
                        enum: ["video", "audio"],
                        description: "Type of track to add",
                    },
                    count: {
                        type: "number",
                        description: "Number of tracks to add (default: 1)",
                    },
                    sequence_id: {
                        type: "string",
                        description: "Sequence name or ID. Uses active sequence if omitted.",
                    },
                },
                required: ["track_type"],
            },
            handler: async (args) => {
                const count = args.count ?? 1;
                const seqLookup = args.sequence_id
                    ? `var seq = __findSequence("${escapeForExtendScript(args.sequence_id)}"); if (!seq) return __error("Sequence not found");`
                    : `var seq = app.project.activeSequence; if (!seq) return __error("No active sequence");`;
                const script = buildToolScript(`
          ${seqLookup}
          if (${count} < 1 || ${count} !== Math.floor(${count})) return __error("count must be a positive integer");
          var before = ${args.track_type === "video" ? "seq.videoTracks.numTracks" : "seq.audioTracks.numTracks"};

          // QE addTracks only operates on the active timeline, so activate and verify it.
          if (app.project.activeSequence !== seq) {
            if (typeof seq.openInTimeline !== "function") {
              return __result({ supported: false, unsupported: true, reason: "Target sequence cannot be activated for QE track creation" });
            }
            seq.openInTimeline();
          }
          if (app.project.activeSequence !== seq) return __error("Target sequence did not become active");
          app.enableQE();
          var qeSeq = (typeof qe !== "undefined" && qe.project && typeof qe.project.getActiveSequence === "function") ? qe.project.getActiveSequence() : null;
          if (!qeSeq || typeof qeSeq.addTracks !== "function") {
            return __result({ supported: false, unsupported: true, reason: "QE Sequence.addTracks is unavailable on this host" });
          }
          ${args.track_type === "video"
                    ? `qeSeq.addTracks(${count}, 0, 0, 0);`
                    : `qeSeq.addTracks(0, ${count}, 0, 0);`}
          var after = ${args.track_type === "video" ? "seq.videoTracks.numTracks" : "seq.audioTracks.numTracks"};
          if (after - before !== ${count}) {
            return __error("Track creation postcondition failed: expected " + ${count} + ", observed " + (after - before));
          }
          return __result({
            supported: true,
            added: after - before,
            trackType: "${args.track_type}",
            totalTracks: after
          });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        delete_track: {
            description: "Delete a video or audio track from the active sequence",
            parameters: {
                type: "object",
                properties: {
                    track_type: {
                        type: "string",
                        enum: ["video", "audio"],
                        description: "Type of track to delete",
                    },
                    track_index: {
                        type: "number",
                        description: "Index of the track to delete (0-based)",
                    },
                },
                required: ["track_type", "track_index"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          ${args.track_type === "video"
                    ? `if (${args.track_index} >= seq.videoTracks.numTracks) return __error("Track index out of range");
               seq.deleteVideoTrackAt(${args.track_index});`
                    : `if (${args.track_index} >= seq.audioTracks.numTracks) return __error("Track index out of range");
               seq.deleteAudioTrackAt(${args.track_index});`}
          
          return __result({ deleted: true, trackType: "${args.track_type}", trackIndex: ${args.track_index} });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        lock_track: {
            description: "Lock or unlock a video track",
            parameters: {
                type: "object",
                properties: {
                    track_index: {
                        type: "number",
                        description: "Video track index (0-based)",
                    },
                    locked: {
                        type: "boolean",
                        description: "True to lock, false to unlock",
                    },
                },
                required: ["track_index", "locked"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          if (${args.track_index} >= seq.videoTracks.numTracks) return __error("Track index out of range");
          
          var track = seq.videoTracks[${args.track_index}];
          track.setLocked(${args.locked ? 1 : 0});
          
          return __result({ trackIndex: ${args.track_index}, locked: ${args.locked}, trackName: track.name });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        toggle_track_visibility: {
            description: "Toggle a video track's visibility (eye icon)",
            parameters: {
                type: "object",
                properties: {
                    track_index: {
                        type: "number",
                        description: "Video track index (0-based)",
                    },
                    visible: {
                        type: "boolean",
                        description: "True to show, false to hide",
                    },
                },
                required: ["track_index", "visible"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          if (${args.track_index} >= seq.videoTracks.numTracks) return __error("Track index out of range");
          
          var track = seq.videoTracks[${args.track_index}];
          track.setMute(${args.visible ? 0 : 1});
          
          return __result({ trackIndex: ${args.track_index}, visible: ${args.visible}, trackName: track.name });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
    };
}
//# sourceMappingURL=tracks.js.map
