import { z } from "zod";
import { join } from "node:path";
import type { BridgeClient } from "../server.js";
import { digest } from "../automation/canonical.js";
import { RetainedReceiptStore, type StoredReceipt } from "./receipts.js";

const id = z.string().trim().min(1).max(512);
export const EFFECT_BATCH_NAMES = new Set(["effects_batch_apply", "effects_batch_remove"]);
export const EFFECT_BATCH_FIELDS = {
  batch_id: z.string().uuid(), expected_host_epoch: id, resume_failed: z.boolean().default(false),
  items: z.array(z.object({ itemKey: id, node_id: id, sequence_id: id, media_type: z.enum(["video", "audio"]).default("video"), effect_name: id, component_index: z.number().int().nonnegative().optional() }).strict()).min(1).max(32),
};
const schema = z.object(EFFECT_BATCH_FIELDS).strict();
type BatchRequest = z.infer<typeof schema>;
interface BatchIdentity extends StoredReceipt { attempts: Record<string, number>; }
interface ItemReceipt extends StoredReceipt {
  batchId: string; itemKey: string; attempt: number; effect: "applied" | "not_applied" | "unknown";
  result?: Record<string, unknown>; error?: { code: string; message: string }; timestamps: { accepted: string; finalized?: string };
}
const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
function itemId(batchId: string, itemKey: string, attempt: number): string {
  const hex = digest({ batchId, itemKey, attempt });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** One daemon owns item identities, durable outcomes and serial native dispatch. */
export class DurableEffectBatch {
  private readonly identities: RetainedReceiptStore<BatchIdentity>;
  private readonly receipts: RetainedReceiptStore<ItemReceipt>;
  private readonly active = new Map<string, { digest: string; promise: Promise<unknown> }>();
  constructor(private readonly bridge: BridgeClient, directory: string, private readonly dispatch: (bridge: BridgeClient, name: string, args: Record<string, unknown>) => Promise<unknown>) {
    this.identities = new RetainedReceiptStore(join(directory, "legacy-batch-identities"));
    this.receipts = new RetainedReceiptStore(join(directory, "legacy-batch-receipts"));
  }
  execute(name: string, raw: unknown): Promise<unknown> {
    if (!EFFECT_BATCH_NAMES.has(name)) return Promise.reject(coded("BATCH_TOOL_INVALID", "Only explicit effect apply/remove batches use this endpoint"));
    const request = schema.parse(raw), { resume_failed, ...semantic } = request;
    if (new Set(request.items.map(item => item.itemKey)).size !== request.items.length) return Promise.reject(coded("BATCH_ITEM_KEY_DUPLICATE", "Batch itemKey values must be unique"));
    const requestDigest = digest({ name, ...semantic });
    const running = this.active.get(request.batch_id);
    if (running) return running.digest === requestDigest ? running.promise : Promise.reject(coded("IDEMPOTENCY_CONFLICT", "The batch ID has another payload"));
    const promise = this.run(name, request, requestDigest).finally(() => this.active.delete(request.batch_id));
    this.active.set(request.batch_id, { digest: requestDigest, promise }); return promise;
  }
  private async run(name: string, request: BatchRequest, requestDigest: string): Promise<unknown> {
    let identity = await this.identities.read(request.batch_id, requestDigest);
    if (!identity) {
      identity = { operationId: request.batch_id, requestDigest, status: "IDENTITY", attempts: {} };
      await this.identities.write(identity);
    }
    const results: Record<string, unknown>[] = [];
    let stopped = false;
    for (const item of request.items) {
      if (stopped) { results.push({ itemKey: item.itemKey, status: "NOT_ATTEMPTED" }); continue; }
      let attempt = identity.attempts[item.itemKey] ?? 1;
      let operationId = itemId(request.batch_id, item.itemKey, attempt);
      const itemDigest = digest({ name, item, expectedHostEpoch: request.expected_host_epoch });
      let prior = await this.receipts.read(operationId, itemDigest);
      if (prior?.status === "FAILED_NO_EFFECT" && request.resume_failed) {
        if (attempt >= 3) { results.push({ ...prior, retryLimitReached: true }); stopped = true; continue; }
        attempt++; operationId = itemId(request.batch_id, item.itemKey, attempt); prior = await this.receipts.read(operationId, itemDigest);
      }
      if (prior && !["SUCCEEDED", "FAILED_NO_EFFECT", "OUTCOME_UNKNOWN"].includes(prior.status)) {
        prior = { ...prior, status: "OUTCOME_UNKNOWN", effect: "unknown", error: { code: "BATCH_ITEM_OUTCOME_UNKNOWN", message: "A prior dispatch lacks a durable result; it cannot be replayed" } };
        await this.receipts.write(prior);
      }
      if (prior) { results.push({ ...prior, reused: true }); stopped = prior.status !== "SUCCEEDED"; continue; }
      identity.attempts[item.itemKey] = attempt; await this.identities.write(identity);
      const initial: ItemReceipt = { operationId, requestDigest: itemDigest, status: "DISPATCH_INTENT", batchId: request.batch_id, itemKey: item.itemKey, attempt, effect: "not_applied", timestamps: { accepted: new Date().toISOString() } };
      await this.receipts.write(initial);
      const result = await this.executeItem(name, item, request.expected_host_epoch, initial);
      await this.receipts.write(result); results.push({ ...result }); stopped = result.status !== "SUCCEEDED";
    }
    return { schemaVersion: 1, batchId: request.batch_id, requestDigest, success: !stopped, results,
      applied: results.filter(item => item.status === "SUCCEEDED").length, outcomeUnknown: results.some(item => item.status === "OUTCOME_UNKNOWN"),
      resume: "Repeat the same batch_id and payload; only resume_failed=true explicitly retries a proven no-effect failure. UNKNOWN items are never replayed." };
  }
  private async executeItem(name: string, item: BatchRequest["items"][number], epoch: string, initial: ItemReceipt): Promise<ItemReceipt> {
    let began = false, mutationDispatched = false, ended = false;
    const toolName = "pr.effect.apply", operationId = initial.operationId;
    const scoped: BridgeClient = {
      get connected() { return bridge.connected; }, get port() { return bridge.port; },
      executeScript: (script, timeout) => bridge.executeScript(script, timeout, { operationId, toolName, mode: "mutate", backend: "cep" }),
      uxp: (operation, args, revision) => {
        if (operation === "timeline.clip.effect") mutationDispatched = true;
        return bridge.uxp(operation, { ...args, expectedHostEpoch: epoch }, revision, { operationId, toolName, mode: "mutate", backend: "uxp" }, 120000);
      },
    };
    const bridge = this.bridge;
    try {
      if (!bridge.beginOperation || !bridge.endOperation) throw coded("AUTHORITY_UNAVAILABLE", "The daemon mutation authority is required");
      await bridge.beginOperation({ operationId, toolName, backend: "uxp", mode: "mutate", args: { ...item, expectedHostEpoch: epoch }, itemCount: 1, timeoutMs: 120000, queueDeadlineMs: 30000 }); began = true;
      const result = await this.dispatch(scoped, name === "effects_batch_remove" ? "remove_effect" : item.media_type === "audio" ? "apply_audio_effect" : "apply_effect", item) as Record<string, unknown>;
      if (result?.success === false) throw Object.assign(new Error(String(result.error ?? result.code)), result);
      const verification = (result.uxpVerification as { verification?: { outcome?: string } } | undefined)?.verification;
      if (verification?.outcome !== "verified") throw Object.assign(coded("BATCH_POSTCONDITION_UNVERIFIED", "The actual effect chain delta was not verified"), { outcomeUnknown: true });
      const terminal = await bridge.endOperation(operationId, "SUCCEEDED"); ended = true;
      if ((typeof terminal === "string" ? terminal : (terminal as { status?: string })?.status) !== "SUCCEEDED") throw Object.assign(coded("BATCH_ITEM_OUTCOME_UNKNOWN", "The daemon could not finalize the item"), { outcomeUnknown: true });
      return { ...initial, status: "SUCCEEDED", effect: "applied", result, timestamps: { ...initial.timestamps, finalized: new Date().toISOString() } };
    } catch (error) {
      const failure = error as { code?: string; message?: string; outcomeUnknown?: boolean };
      const unknown = mutationDispatched || failure.outcomeUnknown === true || /TIMEOUT|DISCONNECT|UNKNOWN/.test(String(failure.code));
      if (began && !ended) { try { await bridge.endOperation!(operationId, unknown ? "UNKNOWN" : "FAILED", failure.code); } catch { /* The durable item remains unknown whenever mutation dispatch occurred. */ } }
      return { ...initial, status: unknown ? "OUTCOME_UNKNOWN" : "FAILED_NO_EFFECT", effect: unknown ? "unknown" : "not_applied", error: { code: failure.code ?? "BATCH_ITEM_FAILED", message: failure.message ?? String(error) }, timestamps: { ...initial.timestamps, finalized: new Date().toISOString() } };
    }
  }
}
