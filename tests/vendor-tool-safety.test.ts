import { describe, expect, it } from "vitest";
import { getAdvancedTools } from "../vendor/upstream/tools/advanced.js";
import { getAudioTools } from "../vendor/upstream/tools/audio.js";
import { getInspectionTools } from "../vendor/upstream/tools/inspection.js";
import { getKeyframeTools } from "../vendor/upstream/tools/keyframes.js";
import { getProjectTools } from "../vendor/upstream/tools/project.js";
import { getScriptingTools } from "../vendor/upstream/tools/scripting.js";
import { getSequenceTools } from "../vendor/upstream/tools/sequence.js";
import { getPlayheadTools } from "../vendor/upstream/tools/playhead.js";
import { getTrackTargetingTools } from "../vendor/upstream/tools/track-targeting.js";
import { getTrackTools } from "../vendor/upstream/tools/tracks.js";
import { getUtilityTools } from "../vendor/upstream/tools/utility.js";

function captureTransport() {
  const scripts: string[] = [];
  return {
    scripts,
    options: {
      transport: {
        executeScript: async (script: string) => {
          scripts.push(script);
          return { success: true, data: {} };
        },
      },
    },
  };
}

describe("vendored Premiere tool safety scripts", () => {
  it("keeps the legacy schema while requiring an explicit FCP XML output directory before dispatch", async () => {
    const capture = captureTransport();
    const tools = getProjectTools(capture.options);
    expect(tools.import_fcp_xml.parameters.required).toEqual(["path", "output_directory"]);
    expect(tools.import_fcp_xml.parameters.properties.output_directory).toBeTruthy();
    expect(tools.import_fcp_xml.parameters.properties.project_path).toBeUndefined();

    const missing = await tools.import_fcp_xml.handler({ path: "D:\\incoming\\master.xml" });
    expect(missing).toMatchObject({ success: false, code: "FCP_XML_OUTPUT_DIRECTORY_REQUIRED" });
    expect(capture.scripts).toHaveLength(0);

    await tools.import_fcp_xml.handler({
      path: 'D:\\incoming\\a"b\\master.xml',
      output_directory: 'D:\\output\\a"b',
    });

    const script = capture.scripts[0];
    expect(script).toContain('var opened = app.openFCPXML("D:\\\\incoming\\\\a\\"b\\\\master.xml", "D:\\\\output\\\\a\\"b")');
    expect(script).toContain('if (!opened) return __error("Premiere could not open the FCP XML")');
    expect(script).toContain('outputDirectory: "D:\\\\output\\\\a\\"b"');
    expect(script).toContain("projectName: importedProject.name");
    expect(script).toContain("projectPath: actualPath");
    expect(script).toContain("outputDirectoryHonored: honored");
    expect(script).toContain("importedProject.saveAs(checkpointPath)");
    expect(script).toContain("FCP_XML_OUTPUT_DIRECTORY_NOT_HONORED");

    await tools.import_fcp_xml.handler({
      path: "D:\\incoming\\master.xml",
      project_path: "D:\\legacy-output",
    });
    expect(capture.scripts[1]).toContain('app.openFCPXML("D:\\\\incoming\\\\master.xml", "D:\\\\legacy-output")');
  });

  it("targets sequence setting mutations by sequence_id", async () => {
    const capture = captureTransport();
    const tools = getUtilityTools(capture.options);
    await tools.set_sequence_frame_rate.handler({ frame_rate: 24, sequence_id: "CUT_02" });
    await tools.set_sequence_resolution.handler({ width: 1920, height: 1080, sequence_id: "CUT_02" });
    await tools.set_sequence_audio_settings.handler({ sample_rate: 48000, sequence_id: "CUT_02" });
    expect(capture.scripts).toHaveLength(3);
    for (const script of capture.scripts) expect(script).toContain('var seq = __findSequence("CUT_02")');
  });

  it("uses capability-checked QE track creation with a postcondition", async () => {
    const capture = captureTransport();
    await getTrackTools(capture.options).add_track.handler({ track_type: "video", count: 2, sequence_id: "seq-2" });
    const script = capture.scripts[0];
    expect(script).toContain('var seq = __findSequence("seq-2")');
    expect(script).toContain('typeof qeSeq.addTracks !== "function"');
    expect(script).toContain("qeSeq.addTracks(2, 0, 0, 0)");
    expect(script).toContain("Track creation postcondition failed");
    expect(script).not.toContain("insertVideoTrackAt");
  });

  it("normalizes pixel position and anchor inputs to Premiere Motion coordinates", async () => {
    const capture = captureTransport();
    const tools = getTrackTargetingTools(capture.options);
    await tools.set_clip_position.handler({ node_id: "clip-1", x: 540, y: 960 });
    await tools.set_clip_anchor_point.handler({ node_id: "clip-1", x: 540, y: 960 });
    expect(capture.scripts).toHaveLength(2);
    for (const script of capture.scripts) {
      expect(script).toContain("var normalizedX = 540 / seq.frameSizeHorizontal");
      expect(script).toContain("var normalizedY = 960 / seq.frameSizeVertical");
      expect(script).toContain("var setStatus = prop.setValue([normalizedX, normalizedY], true)");
      expect(script).toContain("setStatus !== 0 && setStatus !== true");
      expect(script).toContain("var observed = prop.getValue(0, 0)");
      expect(script).toContain("postcondition failed");
    }
  });

  it("targets overwrite and preflights create-from-clips", async () => {
    const capture = captureTransport();
    const tools = getAdvancedTools(capture.options);
    await tools.overwrite_clip.handler({ item_id: "clip-1", sequence_id: "CUT_02" });
    await tools.create_sequence_from_clips.handler({ name: "new-cut", item_ids: ["clip-1"] });
    expect(capture.scripts[0]).toContain('var seq = __findSequence("CUT_02")');
    expect(capture.scripts[1]).toContain('typeof app.project.createNewSequenceFromClips !== "function"');
    expect(capture.scripts[1]).toContain("Sequence creation postcondition failed");
    expect(capture.scripts[1]).toContain("unsupported: true");
  });

  it("does not dispatch unsupported Premiere 26 CEP sequence creation", async () => {
    const capture = captureTransport();
    const result = await getSequenceTools(capture.options).create_sequence.handler({ name: "new-cut", preset_path: "C:/preset.sqpreset" });
    expect(result).toMatchObject({ success: false, code: "PREMIERE_26_CEP_SEQUENCE_CREATE_UNSUPPORTED" });
    expect(capture.scripts).toHaveLength(0);
  });

  it("uses host-unit detection for work-area reads and returns audio dB readback", async () => {
    const capture = captureTransport();
    await getPlayheadTools(capture.options).get_work_area.handler();
    await getAudioTools(capture.options).adjust_audio_levels.handler({ node_id: "clip-1", level_db: -6 });
    await getAudioTools(capture.options).add_audio_keyframes.handler({ node_id: "clip-1", keyframes: [{ time_seconds: 1, level_db: -6 }] });
    expect(capture.scripts[0]).toContain("function workAreaSeconds(value)");
    expect(capture.scripts[0]).toContain('sourceUnits:');
    expect(capture.scripts[1]).toContain("var internalLevel = requestedDb + 15");
    expect(capture.scripts[1]).toContain("Number(readInternal) - 15");
    expect(capture.scripts[2]).toContain("-6 + 15");
    expect(capture.scripts[2]).toContain("levelProp.addKey(kfTime)");
    expect(capture.scripts[2]).not.toContain("addKeyframe");
    expect(capture.scripts[2]).toContain("readbackComplete");
  });

  it("uses locale-independent keyframe lookup and normalized identities", async () => {
    const capture = captureTransport();
    const tools = getKeyframeTools(capture.options);
    await tools.set_effect_property.handler({ node_id: "node-1", effect_name: "Motion", property_name: "Scale", value: 100 });
    await tools.get_keyframes.handler({ node_id: "node-1", effect_name: "모션", property_name: "비율 조정" });
    expect(capture.scripts[0]).toContain('var comp = __findComp(clip.components, ["Motion"], ["Motion"])');
    expect(capture.scripts[0]).toContain('var prop = __findProp(comp, ["Scale"], ["Scale"])');
    expect(capture.scripts[0]).toContain("effect: comp.matchName || comp.displayName");
    expect(capture.scripts[0]).toContain("propertyDisplayName: prop.displayName");
    expect(capture.scripts[1]).toContain("var keys = prop.getKeys() || []");
    expect(capture.scripts[1]).toContain("keyframeCount: keyframes.length");
    expect(capture.scripts[1]).toContain("truncated: false");
    expect(capture.scripts[1]).toContain("audio-level: levelDb = Premiere internal Level - 15");
  });

  it("normalizes inspection keys and bounds DOM inspection", async () => {
    const capture = captureTransport();
    await getInspectionTools(capture.options).get_full_clip_info.handler({ node_id: "node-1" });
    await getScriptingTools(capture.options).inspect_dom_object.handler({ object_path: "app.project", max_depth: 3, max_items: 7, max_properties: 9, max_output_chars: 1234 });
    expect(capture.scripts[0]).toContain("var keys = prop.getKeys() || []");
    expect(capture.scripts[0]).toContain("propInfo.keyframeCount = keys.length");
    expect(capture.scripts[0]).toContain("Math.min(keys.length, 2048)");
    expect(capture.scripts[0]).toContain("propInfo.keyframesComplete");
    expect(capture.scripts[1]).toContain("function readSafe(obj, key)");
    expect(capture.scripts[1]).toContain("function seenIndex(obj)");
    expect(capture.scripts[1]).toContain("maxItems: 7");
    expect(capture.scripts[1]).toContain("maxProps: 9");
    expect(capture.scripts[1]).toContain("maxChars: 1234");
  });
});
