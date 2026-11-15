import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { DurableEffectBatch } from "../src/premiere/effect-batch.js";
import { RetainedReceiptStore } from "../src/premiere/receipts.js";
import { digest } from "../src/automation/canonical.js";
import { executeSemanticExtra } from "../src/premiere/extras.js";
import { editAudio, observedGainEnvelope, type AudioEncodingProfile } from "../src/premiere/audio.js";
import { createMcpServer, type BridgeClient } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
const { createSemanticOperations } = createRequire(import.meta.url)("../uxp-plugin/semantic-ops.cjs");
const verified = { componentNames: ["Effect"], uxpVerification: { verification: { outcome: "verified" } } };
function request() {
  return { batch_id: randomUUID(), expected_host_epoch: "epoch", items: ["a", "b", "c"].map(itemKey => ({ itemKey, node_id: itemKey, sequence_id: "sequence", media_type: "video", effect_name: "Effect" })) };
}
describe("direct implementation review corrections", () => {
  it("builds ducking evidence only from matching observed native knots and interval values", () => {
    const profile: AudioEncodingProfile = { id: "qualified-gain", hostVersion: "26.3", route: "uxp", componentMatchName: "gain", parameterIdentity: "0", encoding: "db_plus_offset", offset: 15, minDb: -96, maxDb: 24, keyframeClock: "clip_relative", qualification: { hostBuild: "26.3", evidenceDigest: "a".repeat(64) } };
    const state = { startTicks: "100", endTicks: "300", inTicks: "0", outTicks: "200", reverse: false };
    const requested = [{ ticks: "100", db: -6 }, { ticks: "200", db: -12 }];
    const result = { values: [{ ticks: "0", value: 9 }, { ticks: "100", value: 3 }], keyframeTicks: ["0", "100"], interpolationSamples: [{ ticks: "50", value: 6 }] };
    const observed = observedGainEnvelope(requested, profile, state, result);
    expect(observed.assertionId).toBe("audio.duck_envelope"); expect(observed.status).toBe("pass");
    expect(observed.actual).toMatchObject({ points: [{ timelineTicks: "100", nativeTicks: "0", db: -6 }, { timelineTicks: "200", nativeTicks: "100", db: -12 }], encodingProfile: "qualified-gain" });
    expect(() => observedGainEnvelope(requested, profile, state, { ...result, values: [{ ticks: "0", value: 9 }, { ticks: "100", value: 4 }] })).toThrow("matching native");
    expect(() => observedGainEnvelope(requested, profile, state, { ...result, keyframeTicks: ["0", "50", "100"] })).toThrow("matching native");
    expect(() => observedGainEnvelope(requested, profile, state, { ...result, interpolationSamples: [{ ticks: "50", value: 7 }] })).toThrow("matching native");
  });
  it("persists separate batch item receipts and resumes only proven no-effect failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-batch-review-")), calls: string[] = [], ids: string[] = [];
    let missing = true;
    const bridge: BridgeClient = { connected: true, port: 1, executeScript: async () => ({}), uxp: async (_operation, _args, _revision, metadata) => { ids.push(metadata!.operationId); return {}; }, beginOperation: async () => ({}), endOperation: async (_id, status) => status };
    const dispatch = async (scoped: BridgeClient, _name: string, item: Record<string, unknown>) => {
      calls.push(String(item.itemKey));
      if (item.itemKey === "b" && missing) throw Object.assign(new Error("missing exact target"), { code: "TARGET_NOT_FOUND" });
      await scoped.uxp("timeline.clip.effect", {}); return verified;
    };
    try {
      const runner = new DurableEffectBatch(bridge, directory, dispatch), input = request();
      const first = await runner.execute("effects_batch_apply", input) as any;
      expect(first.results.map((item: any) => item.status)).toEqual(["SUCCEEDED", "FAILED_NO_EFFECT", "NOT_ATTEMPTED"]);
      await runner.execute("effects_batch_apply", input); expect(calls).toEqual(["a", "b"]);
      missing = false;
      const resumed = await runner.execute("effects_batch_apply", { ...input, resume_failed: true }) as any;
      expect(resumed.success).toBe(true); expect(calls).toEqual(["a", "b", "b", "c"]);
      expect(new Set(ids).size).toBe(3); expect(ids).not.toContain(input.batch_id);
      const restarted = new DurableEffectBatch(bridge, directory, dispatch);
      expect((await restarted.execute("effects_batch_apply", input) as any).success).toBe(true);
      expect(calls).toHaveLength(4);
      await expect(restarted.execute("effects_batch_apply", { ...input, items: [{ ...input.items[0], effect_name: "Changed" }] })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("never replays an unknown batch item even with explicit resume", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-batch-unknown-")); let dispatched = 0;
    const bridge: BridgeClient = { connected: true, port: 1, executeScript: async () => ({}), uxp: async () => { dispatched++; throw Object.assign(new Error("lost result"), { code: "HOST_DISCONNECTED" }); }, beginOperation: async () => ({}), endOperation: async (_id, status) => status };
    const dispatch = async (scoped: BridgeClient) => scoped.uxp("timeline.clip.effect", {});
    try {
      const input = request(), runner = new DurableEffectBatch(bridge, directory, dispatch);
      expect((await runner.execute("effects_batch_apply", input) as any).results[0].status).toBe("OUTCOME_UNKNOWN");
      const restarted = new DurableEffectBatch(bridge, directory, dispatch);
      expect((await restarted.execute("effects_batch_apply", { ...input, resume_failed: true }) as any).outcomeUnknown).toBe(true);
      expect(dispatched).toBe(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("bounds terminal bodies while retaining identities and unresolved results across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-receipts-review-"));
    type Receipt = { operationId: string; requestDigest: string; status: string; data: string };
    try {
      const store = new RetainedReceiptStore<Receipt>(directory, 1, 4096);
      await store.write({ operationId: "old", requestDigest: digest("old"), status: "SUCCEEDED", data: "large-body" });
      await store.write({ operationId: "unknown", requestDigest: digest("unknown"), status: "OUTCOME_UNKNOWN", data: "preserve" });
      await store.write({ operationId: "new", requestDigest: digest("new"), status: "SUCCEEDED", data: "new-body" });
      const restarted = new RetainedReceiptStore<Receipt>(directory, 1, 4096);
      await expect(restarted.read("old", digest("old"))).rejects.toMatchObject({ code: "RESULT_EXPIRED" });
      await expect(restarted.read("old", digest("changed"))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect((await restarted.read("unknown"))?.data).toBe("preserve");
      expect(await readFile(join(directory, digest("old") + ".json"), "utf8")).not.toContain("large-body");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("rejects unbound caption cues and stale inactive-project requests before mutation", async () => {
    let mutations = 0;
    const bridge: BridgeClient = { connected: true, port: 1, executeScript: async () => { mutations++; return {}; }, uxp: async () => { mutations++; return {}; } };
    for (const name of ["captions_cue_count", "captions_cue_snapshot", "captions_export_srt"]) {
      await expect(executeSemanticExtra(bridge, name, { sequence_id: "sequence", cues: [{ id: "1", startTicks: "0", endTicks: "100", text: "old" }] }, async () => ({}))).rejects.toMatchObject({ code: "CAPTION_SOURCE_UNAVAILABLE" });
    }
    await expect(executeSemanticExtra(bridge, "project_close_inactive", { project_guid: "project", save_policy: "discard" }, async () => ({}))).rejects.toMatchObject({ code: "HOST_EPOCH_REQUIRED" });
    const ops = createSemanticOperations({ Project: { getActiveProject: () => { mutations++; return {}; } } }, { host: { version: "26.3" } }, "current");
    await expect(ops.execute("pr.project.close_inactive", { expectedHostEpoch: "stale", projectGuid: "project", savePolicy: "discard" })).rejects.toMatchObject({ code: "STALE_HOST" });
    expect(mutations).toBe(0);
  });
  it("preserves a native audio unknown outcome instead of treating it as a no-effect failure", async () => {
    await expect(editAudio({ executeScript: async () => ({ success: false, code: "AUDIO_READBACK_NOT_VERIFIED", error: "Mismatch after write", outcomeUnknown: true, dispatchState: "dispatched", effect: "unknown" }) }, { node_id: "clip", level_db: -3 }, "scalar")).rejects.toMatchObject({ code: "AUDIO_READBACK_NOT_VERIFIED", outcomeUnknown: true, dispatchState: "dispatched", effect: "unknown" });
  });
  it("routes an effect batch directly to its owner without a parent mutation lease", async () => {
    const calls: string[] = [], input = request();
    const server = createMcpServer({ connected: true, port: 1, executeScript: async () => ({}), uxp: async () => ({}), beginOperation: async () => { throw new Error("parent lease must not begin"); }, endOperation: async () => "SUCCEEDED", workflowRequest: async (method, value: any) => { calls.push(method); expect(value.args.batch_id).toBe(input.batch_id); return { success: true }; } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "review", version: "1" });
    try { await server.connect(serverTransport); await client.connect(clientTransport); const result = await client.callTool({ name: "premiere_effects_batch_apply", arguments: input }); expect(result.isError).toBe(false); expect(calls).toEqual(["legacyEffectBatch"]); }
    finally { await client.close(); await server.close(); }
  });
});
