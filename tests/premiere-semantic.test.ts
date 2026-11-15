import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { formatTimecode, parseTimecode, secondsToTicks } from "../src/premiere/time.js";
import { parseSrt, serializeSrt, mapCuesToTimeline } from "../src/premiere/captions.js";
import { objectSchema } from "../src/premiere/schema.js";
import { parameterTick } from "../src/premiere/audio.js";
import { createMcpServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AssetStore } from "../src/automation/assets.js";
import { OperationRegistry } from "../src/automation/registry.js";
import { digest } from "../src/automation/canonical.js";
import { createPremiereAutomationAdapter } from "../src/adobe-automation-adapter.js";
import type { OperationRequest } from "../src/automation/contracts.js";
const { createSemanticOperations } = createRequire(import.meta.url)("../uxp-plugin/semantic-ops.cjs");

function hostFixture() {
  const clock = (ticks: string | bigint) => ({ ticks: String(ticks), seconds: Number(ticks) / 254016000000 });
  const state = { start: 100n, end: 200n, in: 300n, out: 400n, transactions: 0, cloneCalls: 0, accepted: true, locked: false, selectionLive: false };
  const source = { getId: () => "source", getMediaFilePath: async () => "/source.mov" };
  const item = {
    getProjectItem: async () => source, getName: async () => "clip", getTrackIndex: async () => 0,
    getStartTime: async () => clock(state.start), getEndTime: async () => clock(state.end),
    getInPoint: async () => clock(state.in), getOutPoint: async () => clock(state.out),
    getSpeed: async () => 1, isSpeedReversed: async () => 0, isDisabled: async () => false,
    getComponentChain: async () => ({ getComponentCount: () => 1, getComponentAtIndex: (_index: number) => ({
      getMatchName: async () => "intrinsic.TimeRemap", getDisplayName: async () => "Time Remap", getParamCount: () => 1,
      getParam: (_index: number) => ({ displayName: "Speed", isTimeVarying: () => false, getKeyframeListAsTickTimes: (): { ticks: string }[] => [] }),
    }) }),
    createMoveAction: (t: { ticks: string }) => { expect(state.locked).toBe(true); return () => { state.start += BigInt(t.ticks); state.end += BigInt(t.ticks); }; },
    createSetStartAction: (t: { ticks: string }) => () => { state.start = BigInt(t.ticks); },
    createSetEndAction: (t: { ticks: string }) => () => { state.end = BigInt(t.ticks); },
    createSetInPointAction: (t: { ticks: string }) => () => { state.in = BigInt(t.ticks); },
    createSetOutPointAction: (t: { ticks: string }) => () => { state.out = BigInt(t.ticks); },
  };
  const items = [item];
  const track = { getTrackItems: async () => items };
  const sequence = { guid: "sequence", name: "Sequence", getVideoTrackCount: async () => 1, getAudioTrackCount: async () => 0, getVideoTrack: async () => track };
  const project = { guid: "project", path: "/project.prproj", getActiveSequence: async () => sequence, getSequence: async () => sequence, getSequences: async () => [sequence],
    lockedAccess: (cb: () => void) => { state.locked = true; try { cb(); } finally { state.locked = false; } },
    executeTransaction: (cb: (compound: { addAction(action: () => void): void }) => void) => {
      if (!state.accepted) return false;
      state.transactions++; cb({ addAction: (action: () => void) => action() }); return true;
    } };
  const ppro = {
    Project: { getActiveProject: async () => project, getProject: () => project },
    Guid: { fromString: (id: string) => id }, ClipProjectItem: { cast: (value: unknown) => value },
    TickTime: { createWithTicks: clock, createWithSeconds: (s: number) => clock(secondsToTicks(s)) },
    Constants: { TrackItemType: { CLIP: 1 }, MediaType: { VIDEO: 1, AUDIO: 2, ANY: 0 } },
    SequenceEditor: { getEditor: () => ({
      createCloneTrackItemAction: () => { state.cloneCalls++; return () => undefined; },
      createRemoveItemsAction: () => { expect(state.selectionLive).toBe(true); expect(state.locked).toBe(true); return () => { items.splice(0, 1); }; },
    }) },
    TrackItemSelection: { createEmptySelection: (cb: (selection: { addItem(): boolean }) => void) => {
      state.selectionLive = true; try { cb({ addItem: () => { expect(state.selectionLive).toBe(true); return true; } }); } finally { state.selectionLive = false; } return true;
    } },
  };
  const ops = createSemanticOperations(ppro, { host: { version: "26.3" } }, "epoch");
  const locate = () => ops.execute("timeline.clip.find", { mediaType: "video", trackIndex: 0, clipIndex: 0 });
  return { state, items, ops, locate, ppro };
}
function editableHostFixture() {
  const fixture = hostFixture();
  const values = [
    { value: 1, varying: false, unreadable: false, keys: new Map<string, { value: number; mode: number }>() },
    { value: 2, varying: false, unreadable: false, keys: new Map<string, { value: number; mode: number }>() },
  ];
  const parameter = (index: number) => {
    const value = values[index]!;
    return {
      displayName: index === 0 ? "Exposure" : "Contrast", isTimeVarying: () => value.varying,
      getStartValue: async () => ({ value: { value: value.unreadable ? { opaque: true } : value.value } }),
      getKeyframeListAsTickTimes: () => [...value.keys.keys()].map(ticks => ({ ticks })),
      getValueAtTime: async (time: { ticks: string }) => value.keys.get(time.ticks)?.value ?? value.value,
      getKeyframePtr: (time: { ticks: string }) => ({ getTemporalInterpolationMode: async () => value.keys.get(time.ticks)?.mode ?? 2 }),
      createKeyframe: (next: number) => ({ value: { value: next } }),
      createSetValueAction: (key: { value: { value: number } }) => () => { value.value = key.value.value; },
      createSetTimeVaryingAction: (varying: boolean) => () => { value.varying = varying; },
      createRemoveKeyframeAction: (time: { ticks: string }) => () => { value.keys.delete(time.ticks); },
    };
  };
  const component = (name: string) => ({ getMatchName: async () => name, getDisplayName: async () => name, getParamCount: () => 2, getParam: parameter });
  const components = [component("Test.Effect")];
  const chain = {
    getComponentCount: () => components.length, getComponentAtIndex: (index: number) => components[index]!,
    createAppendComponentAction: (added: ReturnType<typeof component>) => () => { components.push(added); },
    createRemoveComponentAction: (removed: ReturnType<typeof component>) => () => { components.splice(components.indexOf(removed), 1); },
  };
  fixture.items[0]!.getComponentChain = async () => chain;
  const ppro = { ...fixture.ppro, Constants: { ...fixture.ppro.Constants, InterpolationMode: { BEZIER: 0, HOLD: 1, LINEAR: 2 } },
    VideoFilterFactory: { getMatchNames: async () => ["Test.Effect"], createComponent: async (name: string) => component(name) } };
  const ops = createSemanticOperations(ppro, { host: { version: "26.3" } }, "epoch");
  return { ...fixture, ops, values, components, locate: () => ops.execute("timeline.clip.find", { mediaType: "video", trackIndex: 0, clipIndex: 0 }) };
}
describe("Premiere semantic corrections", () => {
  it("guards preserved editable baselines against external gain, keyframe and effect edits", async () => {
    const gain = editableHostFixture(), gainTarget = await gain.locate();
    gain.values[0]!.value = 9;
    await expect(gain.ops.execute("pr.audio.gain", { trackItem: gainTarget.result.handle, componentMatchName: "Test.Effect", parameterIndex: 0, value: 3, mode: "static" })).rejects.toMatchObject({ code: "STALE_TARGET" });
    expect(gain.state.transactions).toBe(0); expect(gain.values[0]!.value).toBe(9);

    const animated = editableHostFixture(); animated.values[0]!.varying = true; animated.values[0]!.keys.set("100", { value: 1, mode: 2 });
    const animationTarget = await animated.locate(); animated.values[0]!.keys.set("100", { value: 7, mode: 2 });
    await expect(animated.ops.execute("pr.parameter.set", { trackItem: animationTarget.result.handle, componentMatchName: "Test.Effect", parameterIndex: 0, value: 3, mode: "static" })).rejects.toMatchObject({ code: "STALE_TARGET" });
    expect(animated.state.transactions).toBe(0);

    const effect = editableHostFixture(), effectTarget = await effect.locate(); effect.components.push(effect.components[0]!);
    await expect(effect.ops.execute("pr.effect.apply", { trackItem: effectTarget.result.handle, matchName: "Test.Effect" })).rejects.toMatchObject({ code: "STALE_TARGET" });
    expect(effect.state.transactions).toBe(0);

    const unknown = editableHostFixture(); unknown.values[0]!.unreadable = true; const unknownTarget = await unknown.locate();
    await expect(unknown.ops.execute("pr.parameter.set", { trackItem: unknownTarget.result.handle, componentMatchName: "Test.Effect", parameterIndex: 0, value: 3, mode: "static" })).rejects.toMatchObject({ code: "EDITABLE_STATE_UNAVAILABLE" });
    expect(unknown.state.transactions).toBe(0);
  });
  it("advances only successful own edit handles through effect creation and multiple parameters", async () => {
    const fixture = editableHostFixture(); fixture.components.length = 0; const found = await fixture.locate();
    const directory = await mkdtemp(join(tmpdir(), "premiere-editable-baseline-"));
    const assets = new AssetStore({ workspace: directory }, join(directory, "owner")); await assets.initialize();
    const host = { app: "premiere" as const, installationId: "installation", hostEpoch: "epoch" };
    const bridge = { connected: true, port: 0, executeScript: async () => { throw new Error("No CEP call expected"); },
      beginOperation: async () => ({}), endOperation: async () => "SUCCEEDED",
      uxp: async (operation: string, args: Record<string, unknown>) => operation === "host.inspect" ? { result: { hostEpoch: "epoch", hostVersion: "26.3" }, verification: { outcome: "verified", method: "fixture host" } } : fixture.ops.execute(operation, args) };
    const adapter = createPremiereAutomationAdapter({ bridge, assets, dataDirectory: join(directory, "owner"), installationId: host.installationId,
      parameterProfiles: ["exposure", "contrast"].map((field, index) => ({ id: field, hostVersion: "26.3", semantic: `effect.lumetri.${field}`, componentMatchName: "Test.Effect", parameterIndex: index, expectedDisplayName: index === 0 ? "Exposure" : "Contrast", encoding: "native", qualificationDigest: "a".repeat(64) })) });
    const request: OperationRequest = { contractVersion: "1.0", jobId: "job", revisionId: "revision", stepKey: "effect", operationId: "effect-operation", executionNamespaceId: "namespace", operation: "pr.effect.apply", host,
      target: { kind: "pr_clip", host, projectGuid: "project", sequenceGuid: "sequence", workingAssetId: "working:project", mediaType: "video", trackIndex: 0, trackFingerprint: "a".repeat(64), structuralFingerprint: "b".repeat(64), clipKey: "clip", sourceAssetId: "source", uxpHandleId: found.result.handle.$ref, sourceRange: { start: { ticks: "300" }, end: { ticks: "400" } }, timelineRange: { start: { ticks: "100" }, end: { ticks: "200" } } },
      args: { effect: { name: "lumetri", exposure: 3, contrast: 4 }, existingEffectPolicy: "create_if_absent" }, assets: {}, assertions: [], waitTimeoutMs: 10000, executionDeadline: new Date(Date.now() + 10000).toISOString() };
    try {
      const prepared = await adapter.prepare(request), result = await adapter.dispatch(prepared);
      expect(result.status).toBe("SUCCEEDED"); expect(fixture.values.map(value => value.value)).toEqual([3, 4]); expect(fixture.state.transactions).toBe(3);
      await expect(fixture.ops.execute("pr.parameter.set", { trackItem: found.result.handle, componentMatchName: "Test.Effect", parameterIndex: 0, value: 8, mode: "static" })).rejects.toMatchObject({ code: "STALE_TARGET" });
      expect(fixture.state.transactions).toBe(3);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("keeps integer ticks exact and handles the dropped minute labels", () => {
    const ticks = parseTimecode("00:01:00;02", { numerator: 30000, denominator: 1001 });
    expect(formatTimecode(ticks, { numerator: 30000, denominator: 1001 }, true)).toBe("00:01:00;02");
    expect(() => parseTimecode("00:01:00;00", 29.97)).toThrow();
    expect(formatTimecode(parseTimecode("12:00:00;00", 29.97), 29.97, true)).toBe("12:00:00;00");
  });
  it("preserves array item requirements and integer/enum constraints", () => {
    const schema = objectSchema({ properties: { items: { type: "array", minItems: 1, items: { type: "object", properties: { n: { type: "integer" }, mode: { enum: ["a", "b"] } }, required: ["n", "mode"] } } }, required: ["items"] });
    expect(schema.safeParse({ items: [{ n: 1.5, mode: "a" }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ n: 1 }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ n: 1, mode: "b" }] }).success).toBe(true);
  });
  it("moves the original to an absolute tick without cloning or changing tracks", async () => {
    const { ops, state, items, locate } = hostFixture();
    const found = await locate();
    const result = await ops.execute("timeline.clip.move_track", { trackItem: found.result.handle, timelineStartTicks: "500" });
    expect(state.start).toBe(500n); expect(state.end).toBe(600n);
    expect(state.cloneCalls).toBe(0); expect(items).toHaveLength(1);
    expect(result.verification.outcome).toBe("verified");
  });
  it("changes source in/out instead of interpreting source values as sequence positions", async () => {
    const { ops, state, locate } = hostFixture(); const found = await locate();
    await ops.execute("timeline.clip.trim", { trackItem: found.result.handle, sourceInTicks: "320", sourceOutTicks: "380",
      timeMapProfile: { componentMatchName: "intrinsic.TimeRemap", parameterIndex: 0, expectedDisplayName: "Speed" } });
    expect([state.in, state.out, state.start, state.end]).toEqual([320n, 380n, 100n, 160n]);
  });
  it("rejects a trim whose existing retime curve was not qualified", async () => {
    const { ops, state, locate } = hostFixture(); const found = await locate();
    await expect(ops.execute("timeline.clip.trim", { trackItem: found.result.handle, sourceOutTicks: "380" })).rejects.toMatchObject({ code: "TIME_MAP_UNQUALIFIED" });
    expect(state.transactions).toBe(0);
  });
  it("converts a qualified keyframe clock using source offset, speed and reverse", () => {
    const state = { startTicks: "100", endTicks: "200", inTicks: "300", outTicks: "500", reverse: true };
    expect(parameterTick("125", state, { keyframeClock: "source", sourceTimeMap: "constant_speed" })).toBe("450");
    expect(parameterTick("125", state, { keyframeClock: "sequence" })).toBe("125");
    expect(() => parameterTick("125", state, {})).toThrow();
  });
  it("publishes strict workflow schemas and routes status to the existing owner", async () => {
    const calls: unknown[] = [];
    const server = createMcpServer({ connected: false, port: 0, executeScript: async () => { throw new Error("No host call expected"); },
      uxp: async () => { throw new Error("No host call expected"); }, workflowRequest: async (method, params) => { calls.push({ method, params }); return { state: "ACCEPTED" }; } });
    const client = new Client({ name: "targeted-semantic-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const workflow = listed.tools.find(tool => tool.name === "premiere_workflow_submit");
      expect(workflow?.inputSchema.type).toBe("object");
      expect(workflow?.inputSchema.required).toContain("requestId");
      await client.callTool({ name: "premiere_workflow_status", arguments: { jobId: "job-1" } });
      expect(calls).toEqual([{ method: "status", params: { jobId: "job-1" } }]);
    } finally { await client.close(); await server.close(); }
  });
  it("returns a canonical inventory receipt with the exact prepared digest and projections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "premiere-receipt-")), mediaPath = join(directory, "source.mov");
    await writeFile(mediaPath, "fixture media bytes");
    const assets = new AssetStore({ workspace: directory }, join(directory, "owner")); await assets.initialize();
    const host = { app: "premiere" as const, installationId: "test-installation", hostEpoch: "test-epoch" };
    const bridge = { connected: true, port: 0, executeScript: async () => { throw new Error("No CEP call expected"); },
      beginOperation: async () => ({}), endOperation: async () => "SUCCEEDED",
      uxp: async (operation: string) => ({ result: operation === "host.inspect" ? { hostEpoch: host.hostEpoch, hostVersion: "26.3" } : {
        projectGuid: "project", sequences: [{ sequenceGuid: "sequence", name: "Sequence", timebase: "10584000000", endTicks: "200", frameSize: { width: 1920, height: 1080 } }],
        tracks: [{ sequenceGuid: "sequence", mediaType: "video", trackIndex: 0, clipCount: 1 }],
        clips: [{ name: "clip", projectItemId: "source", mediaPath, sequenceGuid: "sequence", mediaType: "video", trackIndex: 0, startTicks: "100", endTicks: "200", inTicks: "300", outTicks: "400", speed: 1, reverse: false, disabled: false,
          handle: { $ref: "native-clip", projectGuid: "project", sequenceGuid: "sequence" } }], mediaItems: [{ projectItemId: "source", name: "source", mediaPath }],
      }, verification: { outcome: "verified", method: "Fixture host observation" } }) };
    const adapter = createPremiereAutomationAdapter({ bridge, assets, dataDirectory: join(directory, "owner"), installationId: host.installationId });
    const request: OperationRequest = { contractVersion: "1.0", jobId: "job", revisionId: "revision", stepKey: "inspect", operationId: "inspect-operation", executionNamespaceId: "test-namespace", operation: "pr.timeline.inspect", host,
      target: { kind: "pr_project", host, projectGuid: "project", workingAssetId: "working:project" }, args: {}, assets: {}, assertions: [], waitTimeoutMs: 10000, executionDeadline: new Date(Date.now() + 10000).toISOString() };
    try {
      const prepared = await adapter.prepare(request), receipt = await adapter.dispatch(prepared);
      expect(receipt.status).toBe("SUCCEEDED");
      expect(receipt.requestDigest).toBe(digest(prepared));
      expect(() => new OperationRegistry().validateReceipt("pr.timeline.inspect", receipt)).not.toThrow();
      expect(receipt.resources.sequences?.kind).toBe("collection");
      expect(receipt.resources.items?.kind).toBe("collection");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("does not label a rejected transaction verified", async () => {
    const { ops, state, locate } = hostFixture(); const found = await locate(); state.accepted = false;
    await expect(ops.execute("timeline.clip.move_track", { trackItem: found.result.handle, timelineStartTicks: "500" })).rejects.toMatchObject({ code: "TRANSACTION_REJECTED" });
    expect(state.start).toBe(100n);
  });
  it("uses the selection only inside the host callback and defaults to non-ripple deletion", async () => {
    const { ops, items, locate } = hostFixture(); const found = await locate();
    const result = await ops.execute("timeline.clip.remove", { trackItem: found.result.handle });
    expect(items).toHaveLength(0); expect(result.result.ripple).toBe(false);
  });
  it("rejects an absent locator and an empty effect without a host mutation", async () => {
    const { ops, state, locate } = hostFixture();
    await expect(ops.execute("timeline.clip.find", { mediaType: "video" })).rejects.toMatchObject({ code: "TARGET_TRACK_NOT_FOUND" });
    const found = await locate();
    await expect(ops.execute("timeline.clip.effect", { trackItem: found.result.handle, effectName: "" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(state.transactions).toBe(0);
  });
  it("maps cue clocks through retained cuts and writes actual SRT cues", () => {
    const cues = parseSrt("1\n00:00:02,000 --> 00:00:04,000\nhello\n");
    const mapped = mapCuesToTimeline(cues, [{ sourceAssetId: "a", sourceInTicks: secondsToTicks(3), sourceOutTicks: secondsToTicks(5), timelineStartTicks: "0" }]);
    expect(serializeSrt(mapped)).toContain("00:00:00,000 --> 00:00:01,000");
    expect(mapped[0]?.text).toBe("hello");
  });
});
