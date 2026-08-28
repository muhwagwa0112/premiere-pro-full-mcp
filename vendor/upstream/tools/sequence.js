import { buildToolScript, escapeForExtendScript } from "../bridge/script-builder.js";
import { sendCommand } from "../bridge/file-bridge.js";
export function getSequenceTools(bridgeOptions) {
    return {
        create_sequence: {
            description: "Create a Premiere 26 sequence through the UXP Project API. An optional .sqpreset path may be supplied; CEP fallback fails explicitly without dispatch.",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "Name for the new sequence",
                    },
                    preset_path: {
                        type: "string",
                        description: "Optional .sqpreset path used by Premiere 26 Project.createSequenceWithPresetPath.",
                    },
                },
                required: ["name"],
            },
            handler: async (args) => {
                return {
                    success: false,
                    code: "PREMIERE_26_CEP_SEQUENCE_CREATE_UNSUPPORTED",
                    error: "create_sequence is not dispatched through CEP: Premiere 26.x CEP createNewSequence(name) fails with Not Enough Parameters and createNewSequenceFromPreset is unavailable. Use the UXP sequence creation route.",
                };
            },
        },
        duplicate_sequence: {
            description: "Duplicate an existing sequence",
            parameters: {
                type: "object",
                properties: {
                    sequence_id: {
                        type: "string",
                        description: "Sequence name or ID to duplicate",
                    },
                },
                required: ["sequence_id"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = __findSequence("${escapeForExtendScript(args.sequence_id)}");
          if (!seq) return __error("Sequence not found: ${escapeForExtendScript(args.sequence_id)}");
          
          seq.clone();
          return __result({ duplicated: true, originalName: seq.name });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        delete_sequence: {
            description: "Delete a sequence from the project",
            parameters: {
                type: "object",
                properties: {
                    sequence_id: {
                        type: "string",
                        description: "Sequence name or ID to delete",
                    },
                },
                required: ["sequence_id"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var project = app.project;
          var found = false;
          
          for (var i = 0; i < project.rootItem.children.numItems; i++) {
            var item = project.rootItem.children[i];
            if (item.type === 3) { // sequence type
              var seq = __findSequence("${escapeForExtendScript(args.sequence_id)}");
              if (seq && (item.name === seq.name)) {
                project.deleteSequence(seq);
                found = true;
                break;
              }
            }
          }
          
          if (!found) return __error("Sequence not found: ${escapeForExtendScript(args.sequence_id)}");
          return __result({ deleted: true });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_sequence_settings: {
            description: "Modify sequence settings (frame size, frame rate, etc.)",
            parameters: {
                type: "object",
                properties: {
                    sequence_id: {
                        type: "string",
                        description: "Sequence name or ID. Uses active sequence if omitted.",
                    },
                    width: {
                        type: "number",
                        description: "Frame width in pixels",
                    },
                    height: {
                        type: "number",
                        description: "Frame height in pixels",
                    },
                },
            },
            handler: async (args) => {
                const seqLookup = args.sequence_id
                    ? `var seq = __findSequence("${escapeForExtendScript(args.sequence_id)}"); if (!seq) return __error("Sequence not found");`
                    : `var seq = app.project.activeSequence; if (!seq) return __error("No active sequence");`;
                // Premiere 26.x CEP/ExtendScript: assigning seq.frameSizeHorizontal /
                // frameSizeVertical directly is silently ignored on this host. The
                // working approach (verified live) is to set videoFrameWidth /
                // videoFrameHeight on the settings object and call seq.setSettings().
                const setters = [];
                if (args.width)
                    setters.push(`settings.videoFrameWidth = ${args.width};`);
                if (args.height)
                    setters.push(`settings.videoFrameHeight = ${args.height};`);
                const script = buildToolScript(`
          ${seqLookup}
          var settings = seq.getSettings();
          ${setters.join("\n          ")}
          seq.setSettings(settings);
          return __result({ updated: true, name: seq.name });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        create_subsequence: {
            description: "Create a subsequence (nested sequence) from selected clips or a time range",
            parameters: {
                type: "object",
                properties: {
                    ignore_track_targeting: {
                        type: "boolean",
                        description: "Whether to ignore track targeting (default: false)",
                    },
                },
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          var newSeq = seq.createSubsequence(${args.ignore_track_targeting ? "true" : "false"});
          if (!newSeq) return __error("Failed to create subsequence");
          return __result({ created: true, name: newSeq.name, id: newSeq.sequenceID });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        auto_reframe_sequence: {
            description: "Auto-reframe a sequence for a different aspect ratio",
            parameters: {
                type: "object",
                properties: {
                    sequence_id: {
                        type: "string",
                        description: "Sequence name or ID to reframe. Uses active sequence if omitted.",
                    },
                    target_width: {
                        type: "number",
                        description: "Target frame width in pixels",
                    },
                    target_height: {
                        type: "number",
                        description: "Target frame height in pixels",
                    },
                },
                required: ["target_width", "target_height"],
            },
            handler: async (args) => {
                const seqLookup = args.sequence_id
                    ? `var seq = __findSequence("${escapeForExtendScript(args.sequence_id)}"); if (!seq) return __error("Sequence not found");`
                    : `var seq = app.project.activeSequence; if (!seq) return __error("No active sequence");`;
                const script = buildToolScript(`
          ${seqLookup}
          return __error(
            "auto_reframe_sequence is not supported on Premiere " + app.version +
            " CEP/ExtendScript: seq.autoReframeSequence() exists but throws " +
            "'Not Enough Parameters' in this host (the Auto Reframe feature is " +
            "UXP/UI-only). Reframe the sequence in the Premiere UI first."
          );
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        unnest_sequence: {
            description: "Unnest a nested sequence on the timeline, replacing it with the contents of the nested sequence",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the nested sequence clip on the timeline to unnest",
                    },
                },
                required: ["node_id"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var clip = result.clip;
          var clipName = clip.name;
          var projectItem = clip.projectItem;
          
          if (!projectItem) return __error("Cannot find project item for this clip");
          
          // Check if the project item is a sequence (type 3 = sequence)
          // For nested sequences, the projectItem should reference another sequence
          var nestedSeq = null;
          for (var i = 0; i < app.project.sequences.numSequences; i++) {
            var s = app.project.sequences[i];
            if (s.name === projectItem.name || s.sequenceID === projectItem.nodeId) {
              nestedSeq = s;
              break;
            }
          }
          
          if (!nestedSeq) return __error("Clip is not a nested sequence: " + clipName);
          
          var startTicks = clip.start.ticks;
          var trackIndex = result.trackIndex;
          var trackType = result.trackType;
          
          // Remove the nested sequence clip
          clip.remove(false, false);
          
          // Copy clips from the nested sequence to the current timeline
          var addedClips = [];
          var tracks = trackType === "video" ? nestedSeq.videoTracks : nestedSeq.audioTracks;
          for (var t = 0; t < tracks.numTracks; t++) {
            var track = tracks[t];
            for (var c = 0; c < track.clips.numItems; c++) {
              var nestedClip = track.clips[c];
              if (nestedClip.projectItem) {
                var insertTime = (parseFloat(startTicks) + parseFloat(nestedClip.start.ticks)).toString();
                var targetTrack = trackIndex + t;
                if (trackType === "video") {
                  seq.insertClip(nestedClip.projectItem, insertTime, targetTrack, targetTrack);
                } else {
                  seq.insertClip(nestedClip.projectItem, insertTime, 0, targetTrack);
                }
                addedClips.push(nestedClip.name);
              }
            }
          }
          
          return __result({
            unnested: true,
            nestedSequence: clipName,
            clipsAdded: addedClips.length,
            clips: addedClips
          });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        create_sequence_from_preset: {
            description: "Create a new sequence from a specific preset file (.sqpreset)",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "Name for the new sequence",
                    },
                    preset_path: {
                        type: "string",
                        description: "Full path to the .sqpreset file",
                    },
                },
                required: ["name", "preset_path"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          return __error(
            "create_sequence_from_preset is not supported on Premiere " + app.version +
            " CEP/ExtendScript: app.project.createNewSequenceFromPreset() is undefined " +
            "in this host. Create the sequence from the preset in the Premiere UI first."
          );
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        attach_custom_property: {
            description: "Attach a custom property (key/value pair) to the active sequence",
            parameters: {
                type: "object",
                properties: {
                    property_id: {
                        type: "string",
                        description: "Unique identifier for the custom property",
                    },
                    property_value: {
                        type: "string",
                        description: "Value for the custom property",
                    },
                },
                required: ["property_id", "property_value"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          seq.attachCustomProperty("${escapeForExtendScript(args.property_id)}", "${escapeForExtendScript(args.property_value)}");
          return __result({ attached: true, propertyId: "${escapeForExtendScript(args.property_id)}", value: "${escapeForExtendScript(args.property_value)}" });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        is_work_area_enabled: {
            description: "Check whether the work area bar is enabled on the active sequence",
            parameters: {
                type: "object",
                properties: {},
            },
            handler: async () => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          // Premiere 26.x CEP/ExtendScript exposes no API to read whether the
          // work-area bar is enabled (isWorkAreaBarEnabled / getWorkAreaEnabled
          // do not exist on Sequence). Report the limitation truthfully.
          return __error(
            "is_work_area_enabled is not supported on Premiere 26.x CEP/ExtendScript: " +
            "there is no public API to read the work-area bar enabled state in this host."
          );
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        get_export_file_extension: {
            description: "Get the file extension that would be used when exporting the active sequence with a given preset",
            parameters: {
                type: "object",
                properties: {
                    preset_path: {
                        type: "string",
                        description: "Full path to the export preset file (.epr)",
                    },
                },
                required: ["preset_path"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          var ext = seq.getExportFileExtension("${escapeForExtendScript(args.preset_path)}");
          return __result({ sequenceName: seq.name, presetPath: "${escapeForExtendScript(args.preset_path)}", extension: ext });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
    };
}
//# sourceMappingURL=sequence.js.map
