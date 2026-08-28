import { buildToolScript, escapeForExtendScript } from "../bridge/script-builder.js";
import { sendCommand, sendRawCommand } from "../bridge/file-bridge.js";
export function getScriptingTools(bridgeOptions) {
    return {
        execute_extendscript: {
            description: `Execute custom ExtendScript code in Premiere Pro. The code runs inside an IIFE with helper functions available.

IMPORTANT: You MUST write ES3 syntax (var instead of let/const, no arrow functions, no template literals, no destructuring).

Available helpers (auto-prepended):
- __ticksToSeconds(ticks) / __secondsToTicks(seconds) — time conversion
- __ticksToTimecode(ticks, fps) — timecode string
- __findSequence(idOrName) — find sequence by name or ID
- __findProjectItem(nodeIdOrName) — find project item recursively
- __findClip(nodeId) — find clip in active sequence, returns {clip, trackIndex, clipIndex, trackType}
- __getAllClips(seq) — get all clips in a sequence
- __result(data) — return success with data (MUST call this or __error)
- __error(msg) — return error message
- TICKS_PER_SECOND — constant 254016000000
- app.enableQE() — enable QE DOM access

Your code MUST end with: return __result({...}) or return __error("message")

Example: Set opacity to 50% on all video clips (locale-independent)
  var seq = app.project.activeSequence;
  if (!seq) return __error("No active sequence");
  var count = 0;
  for (var t = 0; t < seq.videoTracks.numTracks; t++) {
    var track = seq.videoTracks[t];
    for (var c = 0; c < track.clips.numItems; c++) {
      var clip = track.clips[c];
      var opacityComp = __findComp(clip.components, ["AE.ADBE Opacity"], ["Opacity", "불투명도"]);
      if (opacityComp) {
        var opacityProp = __findProp(opacityComp, ["ADBE Opacity", "Opacity"], ["Opacity", "불투명도"]);
        if (opacityProp) {
          opacityProp.setValue(50, true);
          count++;
        }
      }
    }
  }
  return __result({updated: count});`,
            parameters: {
                type: "object",
                properties: {
                    code: {
                        type: "string",
                        description: "ExtendScript code to execute (ES3 syntax). Must use return __result({...}) or return __error('...'). Helpers are auto-prepended.",
                    },
                    timeout_ms: {
                        type: "number",
                        description: "Custom timeout in milliseconds (default: 30000). Increase for long operations.",
                    },
                },
                required: ["code"],
            },
            handler: async (args) => {
                const script = buildToolScript(args.code);
                const opts = { ...bridgeOptions };
                if (args.timeout_ms) {
                    opts.timeoutMs = args.timeout_ms;
                }
                return sendRawCommand(script, opts);
            },
        },
        evaluate_expression: {
            description: `Evaluate a simple ExtendScript expression and return its value. Use for quick queries like checking a property, getting a count, or reading state. The expression should be a single value/call — NOT a full script.

Examples:
- "app.project.name" → project name
- "app.project.activeSequence.name" → active sequence name
- "app.project.rootItem.children.numItems" → number of root items
- "app.project.activeSequence.videoTracks.numTracks" → number of video tracks
- "app.version" → Premiere Pro version`,
            parameters: {
                type: "object",
                properties: {
                    expression: {
                        type: "string",
                        description: "ExtendScript expression to evaluate (e.g., 'app.project.name')",
                    },
                },
                required: ["expression"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          try {
            var val = ${args.expression};
            return __result({ value: val, type: typeof val });
          } catch(e) {
            return __error("Expression error: " + e.toString());
          }
        `);
                return sendRawCommand(script, bridgeOptions);
            },
        },
        inspect_dom_object: {
            description: `Inspect a Premiere Pro DOM object and list its properties, methods, and values. Useful for exploring the API and debugging.

Examples:
- "app.project" → project properties
- "app.project.activeSequence" → sequence properties
- "app.project.activeSequence.videoTracks[0].clips[0]" → first clip on V1
- "app.project.activeSequence.videoTracks[0].clips[0].components[0]" → first component of a clip`,
            parameters: {
                type: "object",
                properties: {
                    object_path: {
                        type: "string",
                        description: "Dot-path to the DOM object to inspect (e.g., 'app.project.activeSequence')",
                    },
                    max_depth: {
                        type: "number",
                        description: "Max depth for nested inspection (default: 1, max: 3)",
                    },
                    max_items: {
                        type: "number",
                        description: "Maximum collection items inspected per object (default: 20, max: 100)",
                    },
                    max_properties: {
                        type: "number",
                        description: "Maximum properties inspected per object (default: 50, max: 100)",
                    },
                    max_output_chars: {
                        type: "number",
                        description: "Approximate scalar output budget (default: 20000, max: 100000)",
                    },
                },
                required: ["object_path"],
            },
            handler: async (args) => {
                const maxDepth = Math.max(0, Math.min(args.max_depth ?? 1, 3));
                const maxItems = Math.max(0, Math.min(args.max_items ?? 20, 100));
                const maxProperties = Math.max(1, Math.min(args.max_properties ?? 50, 100));
                const maxOutputChars = Math.max(1000, Math.min(args.max_output_chars ?? 20000, 100000));
                const script = buildToolScript(`
          var __inspectBudget = { chars: 0, maxChars: ${maxOutputChars}, maxItems: ${maxItems}, maxProps: ${maxProperties}, truncated: false };
          var __inspectSeen = [];

          function inspectScalar(value) {
            if (typeof value !== "string") return value;
            var remaining = __inspectBudget.maxChars - __inspectBudget.chars;
            if (remaining <= 0) { __inspectBudget.truncated = true; return "<output budget>"; }
            var text = value;
            if (text.length > remaining) { text = text.substring(0, remaining) + "<truncated>"; __inspectBudget.truncated = true; }
            __inspectBudget.chars += text.length;
            return text;
          }

          function seenIndex(obj) {
            for (var i = 0; i < __inspectSeen.length; i++) {
              try { if (__inspectSeen[i] === obj) return i; } catch (e) {}
            }
            return -1;
          }

          function readSafe(obj, key) {
            try { return { ok: true, value: obj[key] }; }
            catch (e) { return { ok: false, error: e.toString() }; }
          }

          function inspectObj(obj, depth, maxD) {
            if (depth > maxD) return "<max depth>";
            if (obj === null) return null;
            if (obj === undefined) return undefined;
            var t = typeof obj;
            if (t === "string" || t === "number" || t === "boolean") return inspectScalar(obj);
            if (t === "function") return "[function]";
            if (__inspectBudget.chars >= __inspectBudget.maxChars) { __inspectBudget.truncated = true; return "<output budget>"; }
            var prior = seenIndex(obj);
            if (prior >= 0) return "<cycle:" + prior + ">";
            __inspectSeen.push(obj);
            
            var result = {};
            var propCount = 0;
            try {
              for (var key in obj) {
                if (propCount >= __inspectBudget.maxProps || __inspectBudget.chars >= __inspectBudget.maxChars) {
                  result["__truncated"] = true;
                  __inspectBudget.truncated = true;
                  break;
                }
                var read = readSafe(obj, key);
                if (!read.ok) {
                  result[key] = "[access error: " + read.error + "]";
                } else {
                  var val = read.value;
                  var vt = typeof val;
                  if (vt === "function") {
                    result[key] = "[function]";
                  } else if (vt === "object" && val !== null) {
                    if (depth < maxD) {
                      result[key] = inspectObj(val, depth + 1, maxD);
                    } else {
                      result[key] = "[object]";
                    }
                  } else {
                    result[key] = inspectScalar(val);
                  }
                }
                propCount++;
              }
            } catch(e) {
              result["__enumerationError"] = e.toString();
            }

            var common = ["numItems", "numTracks", "numSequences", "length", "name", "displayName", "matchName", "nodeId"];
            for (var ci = 0; ci < common.length; ci++) {
              var commonRead = readSafe(obj, common[ci]);
              if (commonRead.ok && commonRead.value !== undefined) result[common[ci]] = inspectScalar(commonRead.value);
            }

            var collectionLength = -1;
            var countKeys = ["numItems", "numTracks", "numSequences", "length"];
            for (var ni = 0; ni < countKeys.length && collectionLength < 0; ni++) {
              var countRead = readSafe(obj, countKeys[ni]);
              if (countRead.ok && typeof countRead.value === "number") collectionLength = countRead.value;
            }
            if (collectionLength >= 0 && depth < maxD) {
              var itemLimit = Math.min(collectionLength, __inspectBudget.maxItems);
              var items = [];
              for (var ii = 0; ii < itemLimit; ii++) {
                var itemRead = readSafe(obj, ii);
                items.push(itemRead.ok ? inspectObj(itemRead.value, depth + 1, maxD) : "[access error: " + itemRead.error + "]");
              }
              result["__items"] = items;
              if (collectionLength > itemLimit) { result["__itemsTruncated"] = collectionLength - itemLimit; __inspectBudget.truncated = true; }
            }
            
            return result;
          }
          
          try {
            var obj = ${args.object_path};
            if (obj === null || obj === undefined) return __error("Object is null or undefined: ${args.object_path}");
            var inspection = inspectObj(obj, 0, ${maxDepth});
            return __result({
              path: "${args.object_path}",
              type: typeof obj,
              inspection: inspection,
              budget: { maxDepth: ${maxDepth}, maxItems: ${maxItems}, maxProperties: ${maxProperties}, maxOutputChars: ${maxOutputChars}, truncated: __inspectBudget.truncated }
            });
          } catch(e) {
            return __error("Cannot access: ${args.object_path} — " + e.toString());
          }
        `);
                return sendRawCommand(script, bridgeOptions);
            },
        },
        list_clip_effects: {
            description: "List all effects/components on a clip with their properties and current values. Essential for debugging effect issues.",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip to inspect",
                    },
                },
                required: ["node_id"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var clip = result.clip;
          var components = [];
          
          for (var i = 0; i < clip.components.numItems; i++) {
            var comp = clip.components[i];
            var props = [];
            for (var p = 0; p < comp.properties.numItems; p++) {
              var prop = comp.properties[p];
              var info = {
                index: p,
                displayName: prop.displayName,
                matchName: ""
              };
              try { info.matchName = prop.matchName; } catch(e) {}
              try { info.value = prop.getValue(0, 0); } catch(e) {}
              try { info.isTimeVarying = prop.isTimeVarying(); } catch(e) {}
              try { info.keyframesSupported = prop.areKeyframesSupported(); } catch(e) {}
              props.push(info);
            }
            components.push({
              index: i,
              displayName: comp.displayName,
              matchName: comp.matchName,
              properties: props
            });
          }
          
          return __result({
            clipName: clip.name,
            nodeId: clip.nodeId,
            trackType: result.trackType,
            trackIndex: result.trackIndex,
            componentCount: components.length,
            components: components
          });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        get_sequence_structure: {
            description: "Get a complete structural overview of the active sequence: all tracks, all clips with positions, gaps, and clip metadata. Essential for understanding timeline state before making edits.",
            parameters: {
                type: "object",
                properties: {
                    sequence_id: {
                        type: "string",
                        description: "Sequence name or ID. Uses active sequence if omitted.",
                    },
                },
            },
            handler: async (args) => {
                const seqLookup = args.sequence_id
                    ? `var seq = __findSequence("${args.sequence_id}"); if (!seq) return __error("Sequence not found");`
                    : `var seq = app.project.activeSequence; if (!seq) return __error("No active sequence");`;
                const script = buildToolScript(`
          ${seqLookup}
          
          var videoTracks = [];
          for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var track = seq.videoTracks[t];
            var clips = [];
            for (var c = 0; c < track.clips.numItems; c++) {
              var clip = track.clips[c];
              var clipInfo = {
                index: c,
                nodeId: clip.nodeId,
                name: clip.name,
                startSeconds: __ticksToSeconds(clip.start.ticks),
                endSeconds: __ticksToSeconds(clip.end.ticks),
                durationSeconds: __ticksToSeconds(clip.duration.ticks),
                inPointSeconds: __ticksToSeconds(clip.inPoint.ticks),
                outPointSeconds: __ticksToSeconds(clip.outPoint.ticks),
                mediaType: clip.mediaType,
                enabled: null,
                enabledSource: "unavailable"
              };
              try { clipInfo.enabled = !clip.isDisabled(); clipInfo.enabledSource = "clip.isDisabled"; } catch(e) { clipInfo.enabledError = String(e); }
              try { clipInfo.speed = clip.getSpeed(); } catch(e) {}
              clips.push(clipInfo);
            }
            videoTracks.push({
              index: t,
              name: track.name,
              clipCount: clips.length,
              clips: clips,
              isMuted: track.isMuted(),
              isLocked: track.isLocked()
            });
          }
          
          var audioTracks = [];
          for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            var track = seq.audioTracks[t];
            var clips = [];
            for (var c = 0; c < track.clips.numItems; c++) {
              var clip = track.clips[c];
              clips.push({
                index: c,
                nodeId: clip.nodeId,
                name: clip.name,
                startSeconds: __ticksToSeconds(clip.start.ticks),
                endSeconds: __ticksToSeconds(clip.end.ticks),
                durationSeconds: __ticksToSeconds(clip.duration.ticks),
                inPointSeconds: __ticksToSeconds(clip.inPoint.ticks),
                outPointSeconds: __ticksToSeconds(clip.outPoint.ticks),
                mediaType: clip.mediaType
              });
            }
            audioTracks.push({
              index: t,
              name: track.name,
              clipCount: clips.length,
              clips: clips,
              isMuted: track.isMuted(),
              isLocked: track.isLocked()
            });
          }
          
          return __result({
            name: seq.name,
            id: seq.sequenceID,
            durationSeconds: __ticksToSeconds(seq.end),
            videoTrackCount: videoTracks.length,
            audioTrackCount: audioTracks.length,
            videoTracks: videoTracks,
            audioTracks: audioTracks
          });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        get_premiere_state: {
            description: "Get a comprehensive snapshot of the current Premiere Pro state: project info, active sequence, playhead position, selected clips, and available sequences. The best first call to understand the current context.",
            parameters: {},
            handler: async () => {
                const script = buildToolScript(`
          var state = {};
          
          // Project info
          var project = app.project;
          if (!project) return __error("No project is open");
          state.project = {
            name: project.name,
            path: project.path,
            rootItemCount: project.rootItem.children.numItems,
            sequenceCount: project.sequences.numSequences
          };
          
          // List all sequences
          state.sequences = [];
          for (var i = 0; i < project.sequences.numSequences; i++) {
            var seq = project.sequences[i];
            state.sequences.push({
              name: seq.name,
              id: seq.sequenceID,
              duration: __ticksToSeconds(seq.end)
            });
          }
          
          // Active sequence
          var active = project.activeSequence;
          var activeBelongsToProject = false;
          if (active) {
            for (var activeIndex = 0; activeIndex < project.sequences.numSequences; activeIndex++) {
              try { if (String(project.sequences[activeIndex].sequenceID) === String(active.sequenceID)) { activeBelongsToProject = true; break; } } catch(e) {}
            }
          }
          state.projectIdentity = { name: project.name || null, path: project.path || null, documentID: project.documentID || null };
          if (active) {
            if (!activeBelongsToProject) return __error("ACTIVE_SEQUENCE_STALE: active sequence is not present in the current project's sequence collection");
            state.activeSequence = {
              name: active.name,
              id: active.sequenceID,
              durationSeconds: __ticksToSeconds(active.end),
              videoTrackCount: active.videoTracks.numTracks,
              audioTrackCount: active.audioTracks.numTracks
            };
            
            // Playhead
            try {
              var playerPos = active.getPlayerPosition();
              state.playheadSeconds = __ticksToSeconds(playerPos.ticks);
            } catch(e) {}
            
            // Selected clips
            try {
              var sel = active.getSelection();
              state.selectedClips = [];
              for (var i = 0; i < sel.length; i++) {
                state.selectedClips.push({
                  nodeId: sel[i].nodeId,
                  name: sel[i].name
                });
              }
            } catch(e) {
              state.selectedClips = [];
            }
            
            // Quick clip count
            var totalClips = 0;
            for (var t = 0; t < active.videoTracks.numTracks; t++) {
              totalClips += active.videoTracks[t].clips.numItems;
            }
            for (var t = 0; t < active.audioTracks.numTracks; t++) {
              totalClips += active.audioTracks[t].clips.numItems;
            }
            state.activeSequence.totalClipCount = totalClips;
            state.activeSequence.projectIdentity = state.projectIdentity;
            state.activeSequence.belongsToCurrentProject = true;
          } else {
            state.activeSequence = null;
          }
          
          // Premiere version
          try { state.version = app.version; } catch(e) {}
          try { state.buildNumber = app.build; } catch(e) {}
          
          return __result(state);
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
    };
}
//# sourceMappingURL=scripting.js.map
