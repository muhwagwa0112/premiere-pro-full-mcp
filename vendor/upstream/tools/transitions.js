import { buildToolScript, escapeForExtendScript } from "../bridge/script-builder.js";
import { sendCommand } from "../bridge/file-bridge.js";
export function getTransitionsTools(bridgeOptions) {
    return {
        add_transition: {
            description: "Add a video transition between two clips at a cut point. Uses QE DOM.",
            parameters: {
                type: "object",
                properties: {
                    transition_name: {
                        type: "string",
                        description: "Name of the transition (e.g., 'Cross Dissolve', 'Dip to Black')",
                    },
                    track_index: {
                        type: "number",
                        description: "Video track index (0-based)",
                    },
                    cut_point_seconds: {
                        type: "number",
                        description: "Time position in seconds of the cut point where the transition should be placed",
                    },
                    duration_seconds: {
                        type: "number",
                        description: "Duration of the transition in seconds (default: 1.0)",
                    },
                },
                      required: ["transition_name", "track_index", "cut_point_seconds"],
            },
            handler: async (args) => {
                const duration = args.duration_seconds ?? 1.0;
                const script = buildToolScript(`
          // Premiere 26.x CEP-ExtendScript exposes NO public method to *add* a
          // transition. qe.project.getVideoTransitionList() returns an array of
          // localized name strings (157 entries), and QETrack has no
          // addTransition method (only numTransitions). There is no
          // premierepro/TransitionFactory global in this host either. So the
          // only truthful behavior is a clear diagnostic error instead of a
          // fake success or a confusing "Transition not found".
          return __error(
            "add_transition is not supported by this host: Premiere " + app.version +
            " CEP/ExtendScript exposes no public transition-adding API " +
            "(qe.project.getVideoTransitionList returns only localized name strings, " +
            "but QETrack has no addTransition). Use list_available_transitions " +
            "to enumerate installed replacements, or add transitions via the " +
            "Premiere UI / UXP (createAddVideoTransitionAction) which is not " +
            "reachable from CEP ExtendScript."
          );
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        add_transition_to_clip: {
            description: "Add a transition to a specific clip's start or end",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    transition_name: {
                        type: "string",
                        description: "Name of the transition",
                    },
                    position: {
                        type: "string",
                        enum: ["start", "end", "both"],
                        description: "Where to apply the transition (default: end)",
                    },
                    duration_seconds: {
                        type: "number",
                        description: "Duration of the transition in seconds (default: 1.0)",
                    },
                },
                      required: ["node_id", "transition_name"],
            },
            handler: async (args) => {
                const position = args.position || "end";
                const duration = args.duration_seconds ?? 1.0;
                const script = buildToolScript(`
          return __error(
            "add_transition_to_clip is not supported by this host: Premiere " +
            app.version + " CEP/ExtendScript exposes no public transition-adding " +
            "API (QETrack has no addTransition). Add transitions via the Premiere " +
            "UI or UXP (createAddVideoTransitionAction) which cannot be reached " +
            "from CEP ExtendScript."
          );
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        batch_add_transitions: {
            description: "Add the same transition to all cut points on a track",
            parameters: {
                type: "object",
                properties: {
                    transition_name: {
                        type: "string",
                        description: "Name of the transition (e.g., 'Cross Dissolve')",
                    },
                    track_index: {
                        type: "number",
                        description: "Video track index (0-based, default: 0)",
                    },
                    duration_seconds: {
                        type: "number",
                        description: "Duration of each transition in seconds (default: 1.0)",
                    },
                },
                required: ["transition_name"],
            },
            handler: async (args) => {
                const trackIndex = args.track_index ?? 0;
                const duration = args.duration_seconds ?? 1.0;
                const script = buildToolScript(`
          return __error(
            "batch_add_transitions is not supported by this host: Premiere " +
            app.version + " CEP/ExtendScript exposes no public transition-adding " +
            "API (QETrack has no addTransition). Add transitions via the Premiere " +
            "UI or UXP (createAddVideoTransitionAction) which cannot be reached " +
            "from CEP ExtendScript."
          );
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        list_available_transitions: {
            description: "List all available video transitions. Uses QE DOM.",
            parameters: {},
            handler: async () => {
                const script = buildToolScript(`
          app.enableQE();
          var transitions = null;
          var list = [];
          try {
            transitions = qe.project.getVideoTransitionList();
          } catch (e) {
            transitions = null;
          }
          if (transitions) {
            var len = transitions.length;
            for (var i = 0; i < len; i++) {
              try {
                list.push({ name: String(transitions[i]), index: i });
              } catch (e) {}
            }
          }
          return __result(list);
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        list_available_audio_transitions: {
            description: "List all available audio transitions. Uses QE DOM.",
            parameters: {},
            handler: async () => {
                const script = buildToolScript(`
          app.enableQE();
          var transitions = null;
          var list = [];
          try {
            transitions = qe.project.getAudioTransitionList();
          } catch (e) {
            transitions = null;
          }
          if (transitions) {
            var len = transitions.length;
            for (var i = 0; i < len; i++) {
              try {
                list.push({ name: String(transitions[i]), index: i });
              } catch (e) {}
            }
          }
          return __result(list);
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
    };
}
//# sourceMappingURL=transitions.js.map
