import { buildToolScript, escapeForExtendScript } from "../bridge/script-builder.js";
import { sendCommand } from "../bridge/file-bridge.js";
export function getEffectsTools(bridgeOptions) {
    return {
        apply_effect: {
            description: "Apply a video effect to a clip. Uses QE DOM for effect lookup.",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip to apply the effect to",
                    },
                    effect_name: {
                        type: "string",
                        description: "Name of the effect (e.g., 'Gaussian Blur', 'Lumetri Color')",
                    },
                },
                required: ["node_id", "effect_name"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          app.enableQE();
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var effectName = "${escapeForExtendScript(args.effect_name)}";
          // Premiere 26.x CEP/ExtendScript has no public effect-adding API.
          // getVideoEffectList() returns localized name strings and
          // QETrackItem.addVideoEffect is not reliably exposed.
          return __error(
            "apply_effect is not supported by this host: Premiere " + app.version +
            " CEP/ExtendScript has no public effect-adding API. Apply '" +
            effectName + "' in the Premiere UI first, then adjust it here."
          );
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        apply_audio_effect: {
            description: "Apply an audio effect to a clip",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    effect_name: {
                        type: "string",
                        description: "Name of the audio effect",
                    },
                },
                required: ["node_id", "effect_name"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          app.enableQE();
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var effectName = "${escapeForExtendScript(args.effect_name)}";
          return __error(
            "apply_audio_effect is not supported by this host: Premiere " +
            app.version + " CEP/ExtendScript has no public effect-adding API. " +
            "Apply the audio effect in the Premiere UI first, then adjust it here."
          );
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        remove_effect: {
            description: "Remove an effect from a clip by its index or name",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    effect_index: {
                        type: "number",
                        description: "Index of the effect to remove (0-based). Use get_clip_properties to see effects list.",
                    },
                    effect_name: {
                        type: "string",
                        description: "Name of the effect to remove (alternative to effect_index)",
                    },
                },
                required: ["node_id"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          // Premiere 26.x CEP/ExtendScript does not expose a remove() method
          // on clip component objects (verified: clip.components[i].remove is
          // undefined). QE removeEffects() also reports true but leaves the
          // components intact, so there is no truthful way to remove an effect
          // programmatically from this host.
          return __error(
            "remove_effect is not supported by this host: Premiere " + app.version +
            " CEP/ExtendScript exposes no remove() on clip components. Remove the effect in the Premiere UI first."
          );
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        list_available_effects: {
            description: "List all available video effects in Premiere Pro. Uses QE DOM.",
            parameters: {},
            handler: async () => {
                const script = buildToolScript(`
          app.enableQE();
          var effects = null;
          var list = [];
          try { effects = qe.project.getVideoEffectList(); } catch (e) { effects = null; }
          if (effects) {
            var len = effects.length;
            for (var i = 0; i < len; i++) {
              try { list.push({ name: String(effects[i]), index: i }); } catch (e) {}
            }
          }
          return __result(list);
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        list_available_audio_effects: {
            description: "List all available audio effects in Premiere Pro. Uses QE DOM.",
            parameters: {},
            handler: async () => {
                const script = buildToolScript(`
          app.enableQE();
          var effects = null;
          var list = [];
          try { effects = qe.project.getAudioEffectList(); } catch (e) { effects = null; }
          if (effects) {
            var len = effects.length;
            for (var i = 0; i < len; i++) {
              try { list.push({ name: String(effects[i]), index: i }); } catch (e) {}
            }
          }
          return __result(list);
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        color_correct: {
            description: "Apply basic color correction to a clip using Lumetri Color",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    exposure: { type: "number", description: "Exposure adjustment (-4.0 to 4.0)" },
                    contrast: { type: "number", description: "Contrast adjustment (-100 to 100)" },
                    highlights: { type: "number", description: "Highlights adjustment (-100 to 100)" },
                    shadows: { type: "number", description: "Shadows adjustment (-100 to 100)" },
                    whites: { type: "number", description: "Whites adjustment (-100 to 100)" },
                    blacks: { type: "number", description: "Blacks adjustment (-100 to 100)" },
                    temperature: { type: "number", description: "Color temperature adjustment" },
                    tint: { type: "number", description: "Tint adjustment" },
                    saturation: { type: "number", description: "Saturation (0-200, 100 = normal)" },
                },
                required: ["node_id"],
            },
            handler: async (args) => {
                // First apply Lumetri Color effect, then set its properties
                const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          // Apply Lumetri Color if not already present
          var clip = result.clip;
          var hasLumetri = __findComp(clip.components, ["ADBE Lumetri"], ["Lumetri Color", "루메트리 색상"]) !== null;
          
          if (!hasLumetri) {
            // Premiere 26.x CEP/ExtendScript exposes no reliable public API to
            // *add* an effect (getVideoEffectList returns localized name
            // strings, and QETrackItem.addVideoEffect is not reliably exposed).
            // Refuse silently instead of pretending.
            return __error(
              "color_correct cannot add Lumetri Color on this host: Premiere " +
              app.version + " CEP/ExtendScript has no public effect-adding API. " +
              "Apply Lumetri Color in the Premiere UI first, then call color_correct " +
              "to adjust its already-present properties."
            );
          }
          
          // Set Lumetri properties
          var changes = {};
          var lumetriComp = hasLumetri ? __findComp(clip.components, ["ADBE Lumetri"], ["Lumetri Color", "루메트리 색상"]) : null;
          if (lumetriComp) {
            var exposureProp = __findProp(lumetriComp, ["ADBE Lumetri Exposure", "Exposure"], ["Exposure", "노출"]);
            var contrastProp = __findProp(lumetriComp, ["ADBE Lumetri Contrast", "Contrast"], ["Contrast", "대비"]);
            var highlightsProp = __findProp(lumetriComp, ["ADBE Lumetri Highlights"], ["Highlights", "밝은 영역"]);
            var shadowsProp = __findProp(lumetriComp, ["ADBE Lumetri Shadows"], ["Shadows", "어두운 영역"]);
            var whitesProp = __findProp(lumetriComp, ["ADBE Lumetri Whites"], ["Whites", "흰색"]);
            var blacksProp = __findProp(lumetriComp, ["ADBE Lumetri Blacks"], ["Blacks", "검정색"]);
            var temperatureProp = __findProp(lumetriComp, ["ADBE Lumetri Temperature"], ["Temperature", "온도"]);
            var tintProp = __findProp(lumetriComp, ["ADBE Lumetri Tint"], ["Tint", "틴트"]);
            var saturationProp = __findProp(lumetriComp, ["ADBE Lumetri Saturation"], ["Saturation", "채도"]);
            ${args.exposure !== undefined ? `if (exposureProp) { exposureProp.setValue(${args.exposure}, true); changes.exposure = ${args.exposure}; }` : ""}
            ${args.contrast !== undefined ? `if (contrastProp) { contrastProp.setValue(${args.contrast}, true); changes.contrast = ${args.contrast}; }` : ""}
            ${args.highlights !== undefined ? `if (highlightsProp) { highlightsProp.setValue(${args.highlights}, true); changes.highlights = ${args.highlights}; }` : ""}
            ${args.shadows !== undefined ? `if (shadowsProp) { shadowsProp.setValue(${args.shadows}, true); changes.shadows = ${args.shadows}; }` : ""}
            ${args.whites !== undefined ? `if (whitesProp) { whitesProp.setValue(${args.whites}, true); changes.whites = ${args.whites}; }` : ""}
            ${args.blacks !== undefined ? `if (blacksProp) { blacksProp.setValue(${args.blacks}, true); changes.blacks = ${args.blacks}; }` : ""}
            ${args.temperature !== undefined ? `if (temperatureProp) { temperatureProp.setValue(${args.temperature}, true); changes.temperature = ${args.temperature}; }` : ""}
            ${args.tint !== undefined ? `if (tintProp) { tintProp.setValue(${args.tint}, true); changes.tint = ${args.tint}; }` : ""}
            ${args.saturation !== undefined ? `if (saturationProp) { saturationProp.setValue(${args.saturation}, true); changes.saturation = ${args.saturation}; }` : ""}
          }
          
          return __result({ colorCorrected: true, clipName: clip.name, changes: changes });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        apply_lut: {
            description: "Apply a LUT file to a clip via Lumetri Color",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip",
                    },
                    lut_path: {
                        type: "string",
                        description: "Full path to the .cube or .3dl LUT file",
                    },
                },
                required: ["node_id", "lut_path"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          app.enableQE();
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found");
          
          var clip = result.clip;
          
          // Find or apply Lumetri Color
          var lumetriComp = __findComp(clip.components, ["ADBE Lumetri"], ["Lumetri Color", "루메트리 색상"]);
          
          if (!lumetriComp) {
            return __error(
              "apply_lut cannot add Lumetri Color on this host: Premiere " +
              app.version + " CEP/ExtendScript has no public effect-adding API. " +
              "Apply Lumetri Color in the Premiere UI first, then call apply_lut " +
              "to set its Input LUT."
            );
          }
          
          if (!lumetriComp) return __error("Could not apply Lumetri Color effect");
          
          // Set the LUT path
          var inputLutProp = __findProp(lumetriComp, ["ADBE Lumetri Input LUT", "Input LUT"], ["Input LUT", "입력 LUT"]);
          if (!inputLutProp) return __error("Input LUT property not found on Lumetri Color");
          inputLutProp.setValue("${escapeForExtendScript(args.lut_path)}", true);
          
          return __result({ lutApplied: true, clipName: clip.name, lutPath: "${escapeForExtendScript(args.lut_path)}" });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        stabilize_clip: {
            description: "Apply the Warp Stabilizer effect to a clip for video stabilization. Uses QE DOM.",
            parameters: {
                type: "object",
                properties: {
                    node_id: {
                        type: "string",
                        description: "Node ID of the clip to stabilize",
                    },
                    smoothness: {
                        type: "number",
                        description: "Stabilization smoothness percentage (default: 50). Higher = smoother but more cropping.",
                    },
                    method: {
                        type: "string",
                        enum: ["Subspace Warp", "Position", "Position, Scale, Rotation"],
                        description: "Stabilization method (default: 'Subspace Warp')",
                    },
                },
                required: ["node_id"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          app.enableQE();
          var qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) return __error("No active sequence (QE)");
          
          var result = __findClip("${escapeForExtendScript(args.node_id)}");
          if (!result) return __error("Clip not found: ${escapeForExtendScript(args.node_id)}");
          
          var clip = result.clip;
          if (result.trackType !== "video") return __error("Warp Stabilizer can only be applied to video clips");
          
          // Find already-applied Warp Stabilizer (locale-independent)
          var warpComp = __findComp(clip.components, ["ADBE Warp Stabilizer", "Warp Stabilizer"], ["Warp Stabilizer", "변형 안정화"]);
          if (!warpComp) {
            // Premiere 26.x CEP/ExtendScript has no public effect-adding API.
            return __error(
              "stabilize_clip cannot add Warp Stabilizer on this host: Premiere " +
              app.version + " CEP/ExtendScript has no public effect-adding API. " +
              "Apply Warp Stabilizer in the Premiere UI first, then call " +
              "stabilize_clip to adjust its properties."
            );
          }
          
          var changes = { stabilized: true };
          ${args.smoothness !== undefined || args.method !== undefined ? `
          var smoothProp = __findProp(warpComp, ["ADBE Warp Stabilizer Smoothness", "Smoothness"], ["Smoothness", "매끄러움"]);
          var methodProp = __findProp(warpComp, ["ADBE Warp Stabilizer Method", "Method"], ["Method", "방법"]);
          ${args.smoothness !== undefined ? `if (smoothProp) { smoothProp.setValue(${args.smoothness}, true); changes.smoothness = ${args.smoothness}; }` : ""}
          ${args.method !== undefined ? `if (methodProp) { methodProp.setValue("${escapeForExtendScript(args.method)}", true); changes.method = "${escapeForExtendScript(args.method)}"; }` : ""}
          ` : ""}
          
          return __result({ clipName: clip.name, info: "Warp Stabilizer applied. Analysis will begin automatically.", changes: changes });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
    };
}
//# sourceMappingURL=effects.js.map
