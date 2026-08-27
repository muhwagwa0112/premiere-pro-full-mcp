import { buildToolScript, escapeForExtendScript } from "../bridge/script-builder.js";
import { sendCommand } from "../bridge/file-bridge.js";
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, unlinkSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Premiere 26.x CEP/ExtendScript has no exportFramePNG / still-capture API.
 * However, the AME "PNG Sequence (Match Source)" preset plus
 * seq.exportAsMediaDirect DOES write a single-frame PNG when the preset's
 * ADBEStillSequence flag is false (a sequence preset normally has it true,
 * which makes exportAsMediaDirect encode the whole timeline).
 *
 * We therefore clone the stock PNG preset, flip ADBEStillSequence to false,
 * write it to a temp dir, and hand that path to exportAsMediaDirect. The
 * resulting file is a genuine single-frame PNG at the playhead position
 * (verified live on Premiere 26.3.2: 1080x1920 24bpp PNG).
 */
const PNG_SEQUENCE_PRESET_CANDIDATES = [
  // Windows install layout (Premiere Pro 2025/2026)
  "MediaIO\\systempresets\\3F3F3F3F_504E4720\\PNG Sequence (Match Source).epr",
  // Fallback relative to the install dir
  "Settings\\EncoderPresets\\PNG Sequence (Match Source).epr",
];

const JPEG_SEQUENCE_PRESET_CANDIDATES = [
  "MediaIO\\systempresets\\3F3F3F3F_4A504547\\JPEG Sequence (Match Source).epr",
  "Settings\\EncoderPresets\\JPEG Sequence (Match Source).epr",
];

/**
 * Build a single-frame still image preset by cloning a stock image-sequence
 * preset and disabling ADBEStillSequence. Returns the temp preset path (or
 * null if no stock preset could be located). The caller is responsible for
 * deleting the returned file after export.
 */
export function makeSingleFramePreset(premiereInstallPath, preferPng = true) {
  if (!premiereInstallPath) return null;
  const candidates = preferPng ? PNG_SEQUENCE_PRESET_CANDIDATES : JPEG_SEQUENCE_PRESET_CANDIDATES;
  let stockPath = null;
  for (const rel of candidates) {
    const p = join(premiereInstallPath, rel);
    if (existsSync(p)) {
      stockPath = p;
      break;
    }
  }
  if (!stockPath) return null;

  try {
    const xml = readFileSync(stockPath, "utf8");
    // Flip the ADBEStillSequence flag (true -> false) so exportAsMediaDirect
    // writes a single still frame instead of the whole timeline.
    const patched = xml.replace(
      /(<ParamValue>)true(<\/ParamValue>\s*<ParamType>1<\/ParamType>\s*<ParamOrdinalValue>4<\/ParamOrdinalValue>\s*<ParamIdentifier>ADBEStillSequence<\/ParamIdentifier>)/,
      "$1false$2",
    );
    if (patched === xml) return null;
    const dir = mkdtempSync(join(tmpdir(), "ppmc-frame-preset-"));
    const presetPath = join(dir, "single_frame.png.epr");
    writeFileSync(presetPath, patched, "utf8");
    return presetPath;
  } catch {
    return null;
  }
}
export function getExportTools(bridgeOptions) {
    return {
        export_sequence: {
            description: "Export the active sequence using Adobe Media Encoder",
            parameters: {
                type: "object",
                properties: {
                    output_path: {
                        type: "string",
                        description: "Full output file path (e.g., '/Users/me/exports/video.mp4')",
                    },
                    preset_path: {
                        type: "string",
                        description: "Path to an AME preset file (.epr). Uses default H.264 if omitted.",
                    },
                    work_area_only: {
                        type: "boolean",
                        description: "Export only the work area (default: false, exports entire sequence)",
                    },
                },
                required: ["output_path"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          var outputPath = "${escapeForExtendScript(args.output_path)}";
          
          ${args.preset_path
                    ? `var presetPath = "${escapeForExtendScript(args.preset_path)}";`
                    : `// Use default H.264 preset
               var presetPath = "";
               // Try common preset locations
               var presetFile = new File("/Applications/Adobe Media Encoder 2025/MediaIO/systempresets/4028/HDTV 1080p 29.97 High Quality.epr");
               if (presetFile.exists) presetPath = presetFile.fsName;`}
          
          var exportResult = seq.exportAsMediaDirect(
            outputPath,
            presetPath,
            ${args.work_area_only ? "app.encoder.ENCODE_WORKAREA" : "app.encoder.ENCODE_ENTIRE"}
          );
          
          return __result({ exported: true, outputPath: outputPath });
        `);
                return sendCommand(script, { ...bridgeOptions, timeoutMs: 120000 }); // 2 min timeout for exports
            },
        },
        export_frame: {
            description: "Export the current frame as an image file",
            parameters: {
                type: "object",
                properties: {
                    output_path: {
                        type: "string",
                        description: "Full output file path for the still image (e.g., '/Users/me/frame.png').",
                    },
                    time_seconds: {
                        type: "number",
                        description: "Time position in seconds to export. Uses current playhead if omitted.",
                    },
                    format: {
                        type: "string",
                        enum: ["png", "jpg"],
                        description: "Still image format (default: png).",
                    },
                },
                required: ["output_path"],
            },
            handler: async (args) => {
                // 1. Ask the host for its install path so we can locate the stock
                //    PNG/JPEG sequence preset (path differs per version/layout).
                const pathScript = buildToolScript(`
          return __result({ path: app.path || "", version: app.version || "" });
        `);
                const pathResult = await sendCommand(pathScript, bridgeOptions);
                const data = (pathResult && typeof pathResult === 'object' && 'data' in pathResult)
                    ? pathResult.data
                    : pathResult;
                const installPath = data && data.path ? String(data.path) : "";
                if (!installPath) {
                    return { success: false, error: "Could not determine Premiere Pro install path from app.path" };
                }

                const preferPng = (args.format ?? "png").toLowerCase() !== "jpg";
                const presetPath = makeSingleFramePreset(installPath, preferPng);
                if (!presetPath) {
                    return {
                        success: false,
                        error: "Could not locate or patch a stock image-sequence preset to export a single frame. " +
                            "Expected a PNG/JPEG Sequence (Match Source).epr under the Premiere install dir.",
                    };
                }

                const outPath = String(args.output_path);
                const timeSeconds = (typeof args.time_seconds === 'number') ? args.time_seconds : null;
                const outputDir = join(tmpdir(), "ppmc-frame");
                mkdirSync(outputDir, { recursive: true });
                const tempName = `mcp_frame_${Date.now()}.${preferPng ? "png" : "jpg"}`;
                const tempOut = join(outputDir, tempName);

                const exportScript = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          var outPath = ${JSON.stringify(tempOut)};
          var preset = ${JSON.stringify(presetPath)};
          var restoreIn = null, restoreOut = null, restorePos = null;
          var fps = 30;
          var frameTick = Math.round(__secondsToTicks(1 / fps));
          try { restoreIn = seq.getInPoint(); } catch(e) {}
          try { restoreOut = seq.getOutPoint(); } catch(e) {}
          try { restorePos = seq.getPlayerPosition(); } catch(e) {}
          try { var tb = Number(seq.timebase); if (tb > 0) fps = 254016000000 / tb; } catch(e) {}
          frameTick = Math.round(__secondsToTicks(1 / fps));

          try {
            // Capture exactly one frame at the target / playhead position by
            // setting a one-frame sequence in/out window and exporting only
            // that range. ENCODE_ENTIRE ignores the playhead and always re-encodes
            // the whole timeline, so we must use ENCODE_IN_TO_OUT instead.
            ${timeSeconds === null ? `
            var curPos = Number(seq.getPlayerPosition().ticks);
            var inTick = String(curPos);
            var outTick = String(curPos + frameTick);
            ` : `
            var tickBase = __secondsToTicks(${timeSeconds});
            var inTick = String(tickBase);
            var outTick = String(tickBase + frameTick);
            seq.setPlayerPosition(inTick);
            `}
            seq.setInPoint(inTick);
            seq.setOutPoint(outTick);

            var presetFile = new File(preset);
            if (!presetFile.exists) return __error("Preset not found: " + preset);
            var res = seq.exportAsMediaDirect(outPath, preset, app.encoder.ENCODE_IN_TO_OUT);
            // exportAsMediaDirect writes asynchronously but queues the export
            // synchronously; restore the original in/out/playhead now so the
            // sequence window is not left modified (no finally here because it
            // conflicts with sendCommand's IIFE re-wrap).
            try { if (restoreIn !== null && restoreIn !== undefined) seq.setInPoint(restoreIn); } catch(e) {}
            try { if (restoreOut !== null && restoreOut !== undefined) seq.setOutPoint(restoreOut); } catch(e) {}
            try { if (restorePos !== null && restorePos !== undefined) seq.setPlayerPosition(String(restorePos.ticks !== undefined ? restorePos.ticks : restorePos)); } catch(e) {}
            return __result({ exported: true, outputPath: outPath, exportResult: String(res) });
          } catch(e) {
            try { if (restoreIn !== null && restoreIn !== undefined) seq.setInPoint(restoreIn); } catch(e) {}
            try { if (restoreOut !== null && restoreOut !== undefined) seq.setOutPoint(restoreOut); } catch(e) {}
            try { if (restorePos !== null && restorePos !== undefined) seq.setPlayerPosition(String(restorePos.ticks !== undefined ? restorePos.ticks : restorePos)); } catch(e) {}
            return __error("export_frame failed: " + e);
          }
        `);
                const exportResult = await sendCommand(exportScript, { ...bridgeOptions, timeoutMs: 120000 });

                // Clean up the temp preset regardless of outcome.
                try { unlinkSync(presetPath); } catch { /* ignore */ }

                const isError = Boolean(exportResult && typeof exportResult === 'object' && exportResult.success === false);
                if (isError) return exportResult;

                // exportAsMediaDirect writes asynchronously; poll for the file.
                let capturedPath = null;
                for (let attempt = 0; attempt < 120; attempt++) {
                    if (existsSync(tempOut)) {
                        // Allow 0-byte files (still being written) to finish.
                        let size = 0;
                        try { size = statSync(tempOut).size; } catch { /* ignore */ }
                        if (size > 0) { capturedPath = tempOut; break; }
                    }
                    await new Promise((r) => setTimeout(r, 500));
                }

                if (!capturedPath) {
                    try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
                    return { success: false, error: "export_frame timed out waiting for the captured frame file." };
                }

                // Return the captured file to the caller at the requested output_path.
                const finalOutput = outPath;
                try {
                    copyFileSync(capturedPath, finalOutput);
                    return { success: true, data: { exported: true, outputPath: finalOutput } };
                } catch (e) {
                    return { success: true, data: { exported: true, outputPath: capturedPath, note: "Copied to temp: " + String(e) } };
                } finally {
                    try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
                }
            },
        },
        export_as_fcp_xml: {
            description: "Export the active sequence as a Final Cut Pro XML file",
            parameters: {
                type: "object",
                properties: {
                    output_path: {
                        type: "string",
                        description: "Full output file path (e.g., '/Users/me/export.xml')",
                    },
                },
                required: ["output_path"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          seq.exportAsFinalCutProXML("${escapeForExtendScript(args.output_path)}");
          return __result({ exported: true, outputPath: "${escapeForExtendScript(args.output_path)}", format: "FCP XML" });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        export_aaf: {
            description: "Export the active sequence as an AAF file (for Pro Tools, etc.)",
            parameters: {
                type: "object",
                properties: {
                    output_path: {
                        type: "string",
                        description: "Full output file path (e.g., '/Users/me/export.aaf')",
                    },
                    mix_down_video: {
                        type: "boolean",
                        description: "Mix down video to single track (default: true)",
                    },
                    explode_to_mono: {
                        type: "boolean",
                        description: "Explode multichannel audio to mono (default: false)",
                    },
                    sample_rate: {
                        type: "number",
                        description: "Audio sample rate (default: 48000)",
                    },
                    bits_per_sample: {
                        type: "number",
                        description: "Audio bit depth (default: 16)",
                    },
                },
                required: ["output_path"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          seq.exportAsAAF(
            "${escapeForExtendScript(args.output_path)}",
            ${args.mix_down_video !== false ? 1 : 0},
            ${args.explode_to_mono ? 1 : 0},
            ${args.sample_rate ?? 48000},
            ${args.bits_per_sample ?? 16}
          );
          
          return __result({ exported: true, outputPath: "${escapeForExtendScript(args.output_path)}", format: "AAF" });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        add_to_render_queue: {
            description: "Add the active sequence to the Adobe Media Encoder render queue",
            parameters: {
                type: "object",
                properties: {
                    output_path: {
                        type: "string",
                        description: "Full output file path",
                    },
                    preset_path: {
                        type: "string",
                        description: "Path to an AME preset file (.epr)",
                    },
                },
                required: ["output_path"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          var encoder = app.encoder;
          if (!encoder) return __error("Adobe Media Encoder not available");
          
          encoder.launchEncoder();
          
          var outputPath = "${escapeForExtendScript(args.output_path)}";
          ${args.preset_path
                    ? `var presetPath = "${escapeForExtendScript(args.preset_path)}";`
                    : `var presetPath = encoder.ENCODE_MATCH_SEQUENCE;`}
          
          encoder.encodeSequence(
            seq,
            outputPath,
            presetPath,
            0, // workAreaType
            1  // removeOnCompletion
          );
          
          return __result({ queued: true, outputPath: outputPath });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        get_render_queue_status: {
            description: "Get the current status of the Adobe Media Encoder render queue",
            parameters: {},
            handler: async () => {
                const script = buildToolScript(`
          var encoder = app.encoder;
          if (!encoder) return __error("Adobe Media Encoder not available");
          
          return __result({
            isRunning: encoder.isRunning ? encoder.isRunning() : "unknown",
            info: "Check Adobe Media Encoder application for detailed queue status"
          });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        create_subclip: {
            description: "Create a subclip from a project item with in/out points",
            parameters: {
                type: "object",
                properties: {
                    item_id: {
                        type: "string",
                        description: "Node ID or name of the source project item",
                    },
                    name: {
                        type: "string",
                        description: "Name for the subclip",
                    },
                    in_seconds: {
                        type: "number",
                        description: "In-point in seconds",
                    },
                    out_seconds: {
                        type: "number",
                        description: "Out-point in seconds",
                    },
                },
                required: ["item_id", "name", "in_seconds", "out_seconds"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var item = __findProjectItem("${escapeForExtendScript(args.item_id)}");
          if (!item) return __error("Item not found");
          
          var inTicks = __secondsToTicks(${args.in_seconds}).toString();
          var outTicks = __secondsToTicks(${args.out_seconds}).toString();
          
          var subclip = item.createSubClip(
            "${escapeForExtendScript(args.name)}",
            inTicks,
            outTicks,
            0, // hasHardBoundaries
            1, // takeVideo
            1  // takeAudio
          );
          
          if (!subclip) return __error("Failed to create subclip");
          return __result({ created: true, name: "${escapeForExtendScript(args.name)}", source: item.name });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        capture_frame: {
            description: "Capture the current frame and return it as inline image data for the LLM to see. This lets the AI visually inspect the current state of the timeline.",
            parameters: {
                type: "object",
                properties: {
                    time_seconds: {
                        type: "number",
                        description: "Time position in seconds to capture. Uses current playhead if omitted.",
                    },
                    format: {
                        type: "string",
                        enum: ["png", "jpg"],
                        description: "Still image format (default: png).",
                    },
                },
            },
            handler: async (args) => {
                const format = (args.format ?? "png").toLowerCase();
                const preferPng = format !== "jpg";

                const pathScript = buildToolScript(`
          return __result({ path: app.path || "", version: app.version || "" });
        `);
                const pathResult = await sendCommand(pathScript, bridgeOptions);
                const data = (pathResult && typeof pathResult === 'object' && 'data' in pathResult)
                    ? pathResult.data
                    : pathResult;
                const installPath = data && data.path ? String(data.path) : "";
                if (!installPath) {
                    return { success: false, error: "Could not determine Premiere Pro install path from app.path" };
                }

                const presetPath = makeSingleFramePreset(installPath, preferPng);
                if (!presetPath) {
                    return {
                        success: false,
                        error: "Could not locate or patch a stock image-sequence preset for frame capture.",
                    };
                }

                const timeSeconds = (typeof args.time_seconds === 'number') ? args.time_seconds : null;
                const outputDir = join(tmpdir(), "ppmc-capture");
                mkdirSync(outputDir, { recursive: true });
                const tempName = `mcp_capture_${Date.now()}.${format}`;
                const tempOut = join(outputDir, tempName);

                const exportScript = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          var outPath = ${JSON.stringify(tempOut)};
          var preset = ${JSON.stringify(presetPath)};
          var restoreIn = null, restoreOut = null, restorePos = null;
          var fps = 30;
          var frameTick = Math.round(__secondsToTicks(1 / fps));
          try { restoreIn = seq.getInPoint(); } catch(e) {}
          try { restoreOut = seq.getOutPoint(); } catch(e) {}
          try { restorePos = seq.getPlayerPosition(); } catch(e) {}
          try { var tb = Number(seq.timebase); if (tb > 0) fps = 254016000000 / tb; } catch(e) {}
          frameTick = Math.round(__secondsToTicks(1 / fps));

          try {
            // Export only a one-frame in/out window instead of the whole
            // timeline (ENCODE_ENTIRE always re-encodes from the start and
            // ignores the playhead).
            ${timeSeconds === null ? `
            var curPos = Number(seq.getPlayerPosition().ticks);
            var inTick = String(curPos);
            var outTick = String(curPos + frameTick);
            ` : `
            var tickBase = __secondsToTicks(${timeSeconds});
            var inTick = String(tickBase);
            var outTick = String(tickBase + frameTick);
            seq.setPlayerPosition(inTick);
            `}
            seq.setInPoint(inTick);
            seq.setOutPoint(outTick);
            var res = seq.exportAsMediaDirect(outPath, preset, app.encoder.ENCODE_IN_TO_OUT);
            try { if (restoreIn !== null && restoreIn !== undefined) seq.setInPoint(restoreIn); } catch(e) {}
            try { if (restoreOut !== null && restoreOut !== undefined) seq.setOutPoint(restoreOut); } catch(e) {}
            try { if (restorePos !== null && restorePos !== undefined) seq.setPlayerPosition(String(restorePos.ticks !== undefined ? restorePos.ticks : restorePos)); } catch(e) {}
            return __result({ exported: true, outputPath: outPath, exportResult: String(res) });
          } catch(e) {
            try { if (restoreIn !== null && restoreIn !== undefined) seq.setInPoint(restoreIn); } catch(e) {}
            try { if (restoreOut !== null && restoreOut !== undefined) seq.setOutPoint(restoreOut); } catch(e) {}
            try { if (restorePos !== null && restorePos !== undefined) seq.setPlayerPosition(String(restorePos.ticks !== undefined ? restorePos.ticks : restorePos)); } catch(e) {}
            return __error("capture_frame failed: " + e);
          }
        `);
                const exportResult = await sendCommand(exportScript, { ...bridgeOptions, timeoutMs: 120000 });

                try { unlinkSync(presetPath); } catch { /* ignore */ }

                const isError = Boolean(exportResult && typeof exportResult === 'object' && exportResult.success === false);
                if (isError) return exportResult;

                // exportAsMediaDirect writes asynchronously; poll for the file.
                let capturedPath = null;
                for (let attempt = 0; attempt < 120; attempt++) {
                    if (existsSync(tempOut)) {
                        let size = 0;
                        try { size = statSync(tempOut).size; } catch { /* ignore */ }
                        if (size > 0) { capturedPath = tempOut; break; }
                    }
                    await new Promise((r) => setTimeout(r, 500));
                }

                if (!capturedPath) {
                    try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
                    return { success: false, error: "capture_frame timed out waiting for the captured frame file." };
                }

                try {
                    const fileBuf = readFileSync(capturedPath);
                    const b64 = fileBuf.toString("base64");
                    try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
                    return {
                        success: true,
                        data: {
                            captured: true,
                            format,
                            mimeType: preferPng ? "image/png" : "image/jpeg",
                            data: `data:${preferPng ? "image/png" : "image/jpeg"};base64,${b64}`,
                            sizeBytes: fileBuf.length,
                        },
                    };
                } catch (e) {
                    try { rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
                    return { success: false, error: "Failed to read captured frame: " + String(e) };
                }
            },
        },
        export_omf: {
            description: "Export the active sequence as an OMF file (Open Media Framework, for audio post-production)",
            parameters: {
                type: "object",
                properties: {
                    output_path: {
                        type: "string",
                        description: "Full output file path (e.g., '/Users/me/export.omf')",
                    },
                    sample_rate: {
                        type: "number",
                        description: "Audio sample rate (default: 48000)",
                    },
                    bits_per_sample: {
                        type: "number",
                        description: "Audio bit depth (default: 16)",
                    },
                    audio_encapsulated: {
                        type: "boolean",
                        description: "Embed audio in OMF (true) or reference external files (false). Default: true",
                    },
                    audio_file_format: {
                        type: "number",
                        description: "Audio format: 0=AIFF, 1=WAV. Default: 1",
                    },
                    trim_audio_files: {
                        type: "boolean",
                        description: "Trim audio to used range plus handles (default: true)",
                    },
                    handle_frames: {
                        type: "number",
                        description: "Handle length in frames when trimming (default: 1000)",
                    },
                },
                required: ["output_path"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          app.project.exportOMF(
            seq,
            "${escapeForExtendScript(args.output_path)}",
            "OMFTitle",
            ${args.sample_rate ?? 48000},
            ${args.bits_per_sample ?? 16},
            ${args.audio_encapsulated !== false ? 1 : 0},
            ${args.audio_file_format ?? 1},
            ${args.trim_audio_files !== false ? 1 : 0},
            ${args.handle_frames ?? 1000}
          );
          
          return __result({ exported: true, outputPath: "${escapeForExtendScript(args.output_path)}", format: "OMF" });
        `);
                return sendCommand(script, { ...bridgeOptions, timeoutMs: 120000 });
            },
        },
        encode_project_item: {
            description: "Encode a specific project item (not a sequence) using Adobe Media Encoder",
            parameters: {
                type: "object",
                properties: {
                    item_id: {
                        type: "string",
                        description: "Node ID or name of the project item to encode",
                    },
                    output_path: {
                        type: "string",
                        description: "Full output file path",
                    },
                    preset_path: {
                        type: "string",
                        description: "Path to an AME preset file (.epr)",
                    },
                    remove_on_completion: {
                        type: "boolean",
                        description: "Remove from queue on completion (default: true)",
                    },
                },
                required: ["item_id", "output_path", "preset_path"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var item = __findProjectItem("${escapeForExtendScript(args.item_id)}");
          if (!item) return __error("Project item not found: ${escapeForExtendScript(args.item_id)}");
          
          app.encoder.launchEncoder();
          app.encoder.encodeProjectItem(
            item,
            "${escapeForExtendScript(args.output_path)}",
            "${escapeForExtendScript(args.preset_path)}",
            app.encoder.ENCODE_IN_TO_OUT,
            ${args.remove_on_completion !== false ? 1 : 0}
          );
          app.encoder.startBatch();
          
          return __result({
            queued: true,
            item: item.name,
            outputPath: "${escapeForExtendScript(args.output_path)}"
          });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        encode_file: {
            description: "Encode an external file (not in project) using Adobe Media Encoder",
            parameters: {
                type: "object",
                properties: {
                    input_path: {
                        type: "string",
                        description: "Full path to the input file",
                    },
                    output_path: {
                        type: "string",
                        description: "Full output file path",
                    },
                    preset_path: {
                        type: "string",
                        description: "Path to an AME preset file (.epr)",
                    },
                    in_seconds: {
                        type: "number",
                        description: "Optional start time in seconds",
                    },
                    out_seconds: {
                        type: "number",
                        description: "Optional end time in seconds",
                    },
                    remove_on_completion: {
                        type: "boolean",
                        description: "Remove from queue on completion (default: true)",
                    },
                },
                required: ["input_path", "output_path", "preset_path"],
            },
            handler: async (args) => {
                const inPointCode = args.in_seconds !== undefined
                    ? `var srcIn = new Time(); srcIn.seconds = ${args.in_seconds};`
                    : `var srcIn = undefined;`;
                const outPointCode = args.out_seconds !== undefined
                    ? `var srcOut = new Time(); srcOut.seconds = ${args.out_seconds};`
                    : `var srcOut = undefined;`;
                const script = buildToolScript(`
          app.encoder.launchEncoder();
          
          ${inPointCode}
          ${outPointCode}
          
          app.encoder.encodeFile(
            "${escapeForExtendScript(args.input_path)}",
            "${escapeForExtendScript(args.output_path)}",
            "${escapeForExtendScript(args.preset_path)}",
            ${args.remove_on_completion !== false ? 1 : 0},
            srcIn,
            srcOut
          );
          app.encoder.startBatch();
          
          return __result({
            queued: true,
            inputPath: "${escapeForExtendScript(args.input_path)}",
            outputPath: "${escapeForExtendScript(args.output_path)}"
          });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        manage_proxies: {
            description: "Create or attach proxies for a project item",
            parameters: {
                type: "object",
                properties: {
                    item_id: {
                        type: "string",
                        description: "Node ID or name of the project item",
                    },
                    action: {
                        type: "string",
                        enum: ["create", "attach", "toggle"],
                        description: "Action to perform on proxies",
                    },
                    proxy_path: {
                        type: "string",
                        description: "Path to proxy file (required for 'attach' action)",
                    },
                },
                required: ["item_id", "action"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var item = __findProjectItem("${escapeForExtendScript(args.item_id)}");
          if (!item) return __error("Item not found");
          
          var action = "${args.action}";
          
          if (action === "create") {
            item.createProxy("", 0);
            return __result({ action: "create", item: item.name, status: "Proxy creation started" });
          } else if (action === "attach") {
            ${args.proxy_path
                    ? `item.attachProxy("${escapeForExtendScript(args.proxy_path)}", 0);
                 return __result({ action: "attach", item: item.name, proxyPath: "${escapeForExtendScript(args.proxy_path)}" });`
                    : `return __error("proxy_path is required for attach action");`}
          } else if (action === "toggle") {
            app.project.setProxyEnabled(!app.project.isProxyEnabled());
            return __result({ action: "toggle", proxiesEnabled: !app.project.isProxyEnabled() });
          }
          
          return __error("Unknown proxy action: " + action);
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
    };
}
//# sourceMappingURL=export.js.map
