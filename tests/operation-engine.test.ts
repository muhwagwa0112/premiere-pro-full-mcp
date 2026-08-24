import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Backend, BackendAdapter, BridgeRequest, BridgeResponse } from "../src/contracts.js";
import { OperationEngine } from "../src/operation-engine.js";
import { OperationLedger, type LedgerRecord } from "../src/ledger.js";
import { PathPolicy } from "../src/security/path-policy.js";
import { ConfirmationService } from "../src/security/confirmation.js";
import { approveForTest, testApprovalAuthenticator } from "./test-approval.js";
import { SessionLease } from "../src/security/session-lease.js";
import { AuthorizationService } from "../src/security/authorization-service.js";
import type { TrustProfile } from "../src/security/trust-profile.js";
import { effectiveBridgeRequestDigest } from "../src/security/execution-plan.js";
import { createHash } from "node:crypto";
import { vi } from "vitest";

class FakeAdapter implements BackendAdapter {
  calls: BridgeRequest[] = [];
  supportCalls: string[] = [];
  constructor(readonly backend: Backend, public available: boolean, private readonly response: (request: BridgeRequest) => BridgeResponse, private readonly supported = true) {}
  async probe() { return { backend: this.backend, available: this.available, hostVersion: "26.3.2", operations: this.supported ? ["test-advertised"] : [], ...(this.available ? {} : { reason: "test unavailable" }) }; }
  async supports(operation: string) { this.supportCalls.push(operation); return this.supported ? { supported: true as const, state: "implemented_unverified" as const } : { supported: false as const, state: "unsupported" as const, reason: "test unsupported" }; }
  async availability() { return this.available ? { available: true, hostVersion: "26.3.2" } : { available: false, reason: "test unavailable" }; }
  async execute(request: BridgeRequest) { this.calls.push(request); return this.response(request); }
}

async function engineWith(adapters: BackendAdapter[]) {
  const directory = await mkdtemp(join(tmpdir(), "ppmcp-ledger-"));
  const approvalDirectory = await mkdtemp(join(tmpdir(), "ppmcp-approval-"));
  const confirmations = new ConfirmationService(approvalDirectory, testApprovalAuthenticator);
  const lease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
  const authorizationService = new AuthorizationService({ mode: "interactive", lease, confirmations });
  return { engine: new OperationEngine(adapters, { ledger: new OperationLedger(directory), authorizationService, pathPolicy: new PathPolicy(["C:\\approved"]) }), directory, approvalDirectory };
}

const testLeaseAuthenticator = {
  sign: async (message: string) => createHash("sha256").update(message).digest("base64url"),
  verify: async (message: string, signature: string) => signature === createHash("sha256").update(message).digest("base64url"),
};

function success(request: BridgeRequest): BridgeResponse {
  return { protocolVersion: 1, requestId: request.requestId, ok: true, dispatchState: "completed", hostVersion: "26.3.2", afterRevision: "after", verification: { outcome: "verified", method: "test readback" }, result: { ok: true } };
}

async function confirm(engine: OperationEngine, approvalDirectory: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const preview = await engine.preview(request) as { approvalId: string; operationId: string; planHash: string };
  await approveForTest(preview.approvalId, approvalDirectory);
  return { ...request, operationId: preview.operationId, planHash: preview.planHash, approvalId: preview.approvalId };
}

describe("operation routing", () => {
  it("atomically rejects concurrent requests that reuse one operationId with different arguments", async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const calls: BridgeRequest[] = [];
    const adapter: BackendAdapter = {
      backend: "uxp",
      probe: async () => ({ backend: "uxp", available: true, hostVersion: "26.3.2", operations: ["project.inspect"] }),
      supports: async () => ({ supported: true, state: "implemented_unverified" }),
      availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async (request) => { calls.push(request); entered(); await releasePromise; return success(request); },
    };
    const { engine } = await engineWith([adapter]);
    const operationId = "88888888-8888-4888-8888-888888888888";
    const first = engine.execute({ actionId: "project.inspect", args: { scope: "project" }, operationId });
    await enteredPromise;

    const duplicate = await engine.execute({ actionId: "project.inspect", args: { scope: "sequence" }, operationId });
    expect(duplicate).toMatchObject({ operationId, status: "blocked", error: { code: "DUPLICATE_OPERATION_IN_FLIGHT", retryable: false } });
    expect(calls).toHaveLength(1);

    release();
    await expect(first).resolves.toMatchObject({ operationId, status: "succeeded" });
  });

  it("exposes runtime capability metadata without dropping probe fields", async () => {
    const adapter: BackendAdapter = {
      backend: "uxp",
      probe: async () => ({ backend: "uxp", available: true, reason: "test context", hostVersion: "26.3.2", hostSessionId: "session-1", capabilityFingerprint: "fingerprint-1", operations: ["project.inspect"] }),
      supports: async () => ({ supported: true, state: "implemented_unverified" }),
      availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async (request) => success(request),
    };
    const { engine } = await engineWith([adapter]);
    const capabilities = await engine.capabilities() as { backends: Record<string, unknown> };
    expect(capabilities.backends.uxp).toMatchObject({
      reason: "test context",
      hostVersion: "26.3.2",
      hostSessionId: "session-1",
      capabilityFingerprint: "fingerprint-1",
      operations: ["project.inspect"],
    });
  });

  it("selects a fallback only before dispatch", async () => {
    const uxp = new FakeAdapter("uxp", false, success);
    const cep = new FakeAdapter("cep", true, success);
    const { engine, approvalDirectory } = await engineWith([uxp, cep]);
    const request = { actionId: "project.save", args: {} };
    const result = await engine.execute(await confirm(engine, approvalDirectory, request));
    expect(result.status).toBe("succeeded");
    expect(result.backend).toBe("cep");
    expect(uxp.calls).toHaveLength(0);
    expect(cep.calls).toHaveLength(1);
  });

  it("skips a connected adapter that does not support the operation before authorization", async () => {
    const uxp = new FakeAdapter("uxp", true, success, false);
    const cep = new FakeAdapter("cep", true, success);
    const { engine, approvalDirectory } = await engineWith([uxp, cep]);
    const request = { actionId: "project.save", args: {} };
    const result = await engine.execute(await confirm(engine, approvalDirectory, request));
    expect(result).toMatchObject({ status: "succeeded", backend: "cep" });
    expect(uxp.supportCalls).toEqual(["project.save", "project.save"]);
    expect(uxp.calls).toHaveLength(0);
    expect(cep.calls).toHaveLength(1);
  });

  it("falls back after an explicit not_dispatched result", async () => {
    const uxp = new FakeAdapter("uxp", true, (request) => ({ protocolVersion: 1, requestId: request.requestId, ok: false, dispatchState: "not_dispatched", error: { code: "PRE_SEND_FAILURE", message: "socket closed before send", retryable: true } }));
    const cep = new FakeAdapter("cep", true, success);
    const { engine, directory } = await engineWith([uxp, cep]);
    const request = { actionId: "project.inspect", args: {} };
    const result = await engine.execute(request);
    expect(result).toMatchObject({ status: "succeeded", backend: "cep" });
    expect(uxp.calls).toHaveLength(1);
    expect(cep.calls).toHaveLength(1);
    const records = (await readFile(join(directory, "ledger.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { backend: Backend; status: string });
    expect(records).not.toContainEqual(expect.objectContaining({ backend: "uxp", status: "dispatched" }));
    expect(records).toContainEqual(expect.objectContaining({ backend: "uxp", status: "planned" }));
    expect(records).toContainEqual(expect.objectContaining({ backend: "cep", status: "dispatched" }));
  });

  it("previews and approves a new exact route after interactive not_dispatched fallback", async () => {
    const uxp = new FakeAdapter("uxp", true, (request) => ({ protocolVersion: 1, requestId: request.requestId, ok: false, dispatchState: "not_dispatched", error: { code: "PRE_SEND_FAILURE", message: "socket closed before send", retryable: true } }));
    const cep = new FakeAdapter("cep", true, success);
    const { engine, approvalDirectory } = await engineWith([uxp, cep]);
    const request = { actionId: "project.save", args: {} };
    const firstApply = await confirm(engine, approvalDirectory, request);
    const result = await engine.execute(firstApply);
    expect(result).toMatchObject({ operationId: firstApply.operationId, status: "blocked", backend: "uxp", error: { code: "ROUTE_REAUTHORIZATION_REQUIRED", retryable: false } });
    expect(uxp.calls).toHaveLength(1);
    expect(cep.calls).toHaveLength(0);

    const fallbackPreview = await engine.preview({ ...request, operationId: firstApply.operationId }) as { approvalId: string; operationId: string; planHash: string; backend: Backend };
    expect(fallbackPreview).toMatchObject({ operationId: firstApply.operationId, backend: "cep" });
    expect(fallbackPreview.planHash).not.toBe(firstApply.planHash);
    await approveForTest(fallbackPreview.approvalId, approvalDirectory);
    const fallbackResult = await engine.execute({ ...request, operationId: fallbackPreview.operationId, planHash: fallbackPreview.planHash, approvalId: fallbackPreview.approvalId });
    expect(fallbackResult).toMatchObject({ operationId: firstApply.operationId, status: "succeeded", backend: "cep" });
    expect(uxp.calls).toHaveLength(1);
    expect(cep.calls).toHaveLength(1);
  });

  it("preserves the preview operationId when apply loses every prepared backend", async () => {
    const uxp = new FakeAdapter("uxp", true, success);
    const { engine, approvalDirectory } = await engineWith([uxp]);
    const request = { actionId: "project.save", args: {} };
    const approved = await confirm(engine, approvalDirectory, request);
    uxp.available = false;

    const result = await engine.execute(approved);

    expect(result).toMatchObject({ operationId: approved.operationId, status: "blocked", error: { code: "NO_BACKEND_AVAILABLE", retryable: true } });
    await expect(stat(join(approvalDirectory, `approved-${approved.approvalId}.json`))).resolves.toBeDefined();
  });

  it("releases authorization when the planned ledger record fails before dispatch", async () => {
    class FailOnceLedger extends OperationLedger {
      #fail = true;
      override async record(entry: LedgerRecord): Promise<void> {
        if (this.#fail && entry.status === "planned") { this.#fail = false; throw new Error("injected ledger failure"); }
        return super.record(entry);
      }
    }
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-fail-once-ledger-"));
    const approvalDirectory = await mkdtemp(join(tmpdir(), "ppmcp-fail-once-approval-"));
    const confirmations = new ConfirmationService(approvalDirectory, testApprovalAuthenticator);
    const lease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
    const adapter = new FakeAdapter("cep", true, success);
    const engine = new OperationEngine([adapter], {
      ledger: new FailOnceLedger(directory),
      authorizationService: new AuthorizationService({ mode: "interactive", lease, confirmations }),
      pathPolicy: new PathPolicy(["C:\\approved"]),
    });
    const request = { actionId: "project.inspect", args: {}, operationId: "77777777-7777-4777-8777-777777777777" };

    const failed = await engine.execute(request);
    const retried = await engine.execute(request);

    expect(failed).toMatchObject({ operationId: request.operationId, status: "blocked", error: { code: "PRE_DISPATCH_RECORD_FAILED" } });
    expect(retried).toMatchObject({ operationId: request.operationId, status: "succeeded", backend: "cep" });
    expect(adapter.calls).toHaveLength(1);
  });

  it("treats a throwing pre-dispatch re-probe as not_dispatched and falls back", async () => {
    let probes = 0;
    const uxp: BackendAdapter = {
      backend: "uxp",
      probe: async () => {
        probes += 1;
        if (probes === 2) throw new Error("injected pre-dispatch probe failure");
        return { backend: "uxp", available: true, hostVersion: "26.3.2", operations: ["project.inspect"] };
      },
      supports: async () => ({ supported: true, state: "implemented_unverified" }),
      availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async (request) => success(request),
    };
    const cep = new FakeAdapter("cep", true, success);
    const { engine } = await engineWith([uxp, cep]);

    const result = await engine.execute({ actionId: "project.inspect", args: {} });

    expect(result).toMatchObject({ status: "succeeded", backend: "cep" });
    expect(cep.calls).toHaveLength(1);
  });

  it("revalidates the process lease after route probing and before dispatch", async () => {
    let now = 1_000;
    let probes = 0;
    let executes = 0;
    const adapter: BackendAdapter = {
      backend: "cep",
      probe: async () => {
        probes += 1;
        if (probes === 2) now = 1_101;
        return { backend: "cep", available: true, hostVersion: "26.3.2", operations: ["project.inspect"] };
      },
      supports: async () => ({ supported: true, state: "implemented_unverified" }),
      availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async (request) => { executes += 1; return success(request); },
    };
    const lease = await SessionLease.createForCurrentProcess({ ttlMs: 100, now: () => now, pid: 42, processStartTime: 500, authenticate: testLeaseAuthenticator });
    const authorizationService = new AuthorizationService({ mode: "interactive", lease });
    const engine = new OperationEngine([adapter], { authorizationService, ledger: new OperationLedger(await mkdtemp(join(tmpdir(), "ppmcp-expiring-lease-ledger-"))) });

    const result = await engine.execute({ actionId: "project.inspect", args: {}, operationId: "88888888-8888-4888-8888-888888888888" });

    expect(result).toMatchObject({ operationId: "88888888-8888-4888-8888-888888888888", status: "blocked", error: { code: "SESSION_LEASE_INVALID", retryable: false } });
    expect(executes).toBe(0);
  });

  it("does not replay a failed mutation through another backend", async () => {
    const uxp = new FakeAdapter("uxp", true, (request) => ({ protocolVersion: 1, requestId: request.requestId, ok: false, dispatchState: "unknown", error: { code: "UXP_FAILED", message: "partial state unknown", retryable: true } }));
    const cep = new FakeAdapter("cep", true, success);
    const { engine, approvalDirectory } = await engineWith([uxp, cep]);
    const request = { actionId: "project.save", args: {} };
    const result = await engine.execute(await confirm(engine, approvalDirectory, request));
    expect(result.status).toBe("reconciliation_required");
    expect(result.error?.code).toBe("OUTCOME_UNKNOWN");
    expect(result.error?.retryable).toBe(false);
    expect(result.verification.outcome).toBe("committed_unverified");
    expect(uxp.calls).toHaveLength(1);
    expect(cep.calls).toHaveLength(0);
  });

  it("keeps retryable read-only bridge failures retryable", async () => {
    const cep = new FakeAdapter("cep", true, (request) => ({ protocolVersion: 1, requestId: request.requestId, ok: false, dispatchState: "completed", error: { code: "CEP_TIMEOUT", message: "read timed out", retryable: true } }));
    const { engine } = await engineWith([cep]);
    const result = await engine.execute({ actionId: "project.inspect", args: {} });
    expect(result.error).toMatchObject({ code: "CEP_TIMEOUT", retryable: true });
    expect(result.verification.outcome).toBe("failed");
  });

  it("marks mutation adapter exceptions as non-retryable unknown outcomes", async () => {
    const cep: BackendAdapter = {
      backend: "cep",
      probe: async () => ({ backend: "cep", available: true, hostVersion: "26.3.2", operations: ["project.save"] }),
      supports: async () => ({ supported: true, state: "implemented_unverified" }),
      availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async () => { throw new Error("connection lost after dispatch"); },
    };
    const { engine, approvalDirectory } = await engineWith([cep]);
    const request = { actionId: "project.save", args: {} };
    const result = await engine.execute(await confirm(engine, approvalDirectory, request));
    expect(result.error).toMatchObject({ code: "OUTCOME_UNKNOWN", retryable: false });
    expect(result.warnings[0]).toContain("never retry");
  });

  it.each(["accepted", "completed", "unknown"] as const)("never replays a %s outcome", async (dispatchState) => {
    const uxp = new FakeAdapter("uxp", true, (request) => ({ protocolVersion: 1, requestId: request.requestId, ok: false, dispatchState, error: { code: "INJECTED_FAILURE", message: dispatchState, retryable: true } }));
    const cep = new FakeAdapter("cep", true, success);
    const { engine } = await engineWith([uxp, cep]);
    const result = await engine.execute({ actionId: "project.inspect", args: {} });
    expect(result.status).toBe(dispatchState === "completed" ? "failed" : "reconciliation_required");
    expect(uxp.calls).toHaveLength(1);
    expect(cep.calls).toHaveLength(0);
    if (dispatchState === "unknown") expect(result.error).toMatchObject({ code: "OUTCOME_UNKNOWN", retryable: false });
    if (dispatchState === "accepted") {
      expect(result.error).toMatchObject({ code: "OUTCOME_ACCEPTED", retryable: false });
      expect(result.verification.outcome).toBe("committed_unverified");
      expect(result.warnings[0]).toContain("accepted");
    }
  });

  it("requires and consumes exact confirmation for R2 actions", async () => {
    const cep = new FakeAdapter("cep", true, success);
    const { engine, approvalDirectory } = await engineWith([cep]);
    const request = { actionId: "media.import", args: { paths: ["C:\\approved\\clip.mov"] }, expectedRevision: "before" };
    const blocked = await engine.execute(request);
    expect(blocked.status).toBe("confirmation_required");
    const preview = await engine.preview(request) as { approvalId: string; operationId: string; planHash: string };
    await approveForTest(preview.approvalId, approvalDirectory);
    const result = await engine.execute({ ...request, operationId: preview.operationId, planHash: preview.planHash, approvalId: preview.approvalId });
    expect(result.status).toBe("succeeded");
    expect(cep.calls).toHaveLength(1);
  });

  it("does not issue a one-shot approval while every backend is unavailable", async () => {
    const uxp = new FakeAdapter("uxp", false, success);
    const { engine, approvalDirectory } = await engineWith([uxp]);
    const request = { actionId: "export.frame", args: { outputPath: "C:\\approved\\frame.png", timeSeconds: 1 } };
    await expect(engine.preview(request)).rejects.toThrow("NO_BACKEND_AVAILABLE");
    await expect(stat(approvalDirectory)).resolves.toBeDefined();
  });

  it("rejects a non-overwrite sequence export before confirmation or dispatch when the output exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-existing-export-"));
    const outputPath = join(root, "existing.mp4");
    const presetPath = join(root, "preset.epr");
    await writeFile(outputPath, "existing", "utf8");
    await writeFile(presetPath, "preset", "utf8");
    const uxp = new FakeAdapter("uxp", true, success);
    const ledgerDirectory = await mkdtemp(join(tmpdir(), "ppmcp-ledger-"));
    const approvalDirectory = await mkdtemp(join(tmpdir(), "ppmcp-approval-"));
    const confirmations = new ConfirmationService(approvalDirectory, testApprovalAuthenticator);
    const lease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
    const engine = new OperationEngine([uxp], {
      ledger: new OperationLedger(ledgerDirectory),
      authorizationService: new AuthorizationService({ mode: "interactive", lease, confirmations }),
      pathPolicy: new PathPolicy([root]),
    });
    const result = await engine.execute({ actionId: "export.sequence", args: { outputPath, presetPath, overwrite: false } });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("REQUEST_REJECTED");
    expect(result.error?.message).toContain("refused to overwrite");
    expect(uxp.calls).toHaveLength(0);
  });

  it("persists only privacy-safe ledger fields", async () => {
    const cep = new FakeAdapter("cep", true, success);
    const { engine, directory, approvalDirectory } = await engineWith([cep]);
    const request = { actionId: "project.save", args: {} };
    await engine.execute(await confirm(engine, approvalDirectory, request));
    const ledger = await readFile(join(directory, "ledger.jsonl"), "utf8");
    expect(ledger).toContain("project.save");
    expect(ledger).not.toContain("args");
    expect(ledger).not.toContain("projectPath");
  });

  it("hashes caller and bridge revision values before persistence", async () => {
    const sensitive = "private-path-marker";
    const cep = new FakeAdapter("cep", true, (request) => ({ ...success(request), beforeRevision: sensitive, afterRevision: `${sensitive}-after` }));
    const { engine, directory, approvalDirectory } = await engineWith([cep]);
    const request = { actionId: "project.save", args: {}, expectedRevision: "safe-revision" };
    await engine.execute(await confirm(engine, approvalDirectory, request));
    const ledger = await readFile(join(directory, "ledger.jsonl"), "utf8");
    expect(ledger).not.toContain(sensitive);
    expect(ledger).not.toContain("safe-revision");
    expect(ledger).toContain("sha256:");
  });

  it("atomically migrates legacy raw revision values on initialization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-ledger-migration-"));
    const legacy = { operationId: "legacy-op", actionId: "project.save", backend: "cep", risk: "R2", status: "succeeded", timestamp: new Date().toISOString(), verificationOutcome: "verified", beforeRevision: "legacy-private-revision", afterRevision: null };
    await writeFile(join(directory, "ledger.jsonl"), `${JSON.stringify(legacy)}\n`);
    const ledger = new OperationLedger(directory);
    await expect(ledger.get("legacy-op")).resolves.toMatchObject({ beforeRevision: expect.stringMatching(/^sha256:/) });
    const migrated = await readFile(join(directory, "ledger.jsonl"), "utf8");
    expect(migrated).not.toContain("legacy-private-revision");
  });

  it("keeps a durable restart quarantine when post-dispatch ledger writes fail", async () => {
    class FailAfterPlannedLedger extends OperationLedger {
      calls = 0;
      override async record(entry: LedgerRecord): Promise<void> {
        this.calls++;
        if (this.calls > 1) throw new Error("injected ledger write failure");
        await super.record(entry);
      }
    }
    const root = await mkdtemp(join(tmpdir(), "ppmcp-ledger-dispatch-failure-root-"));
    const ledgerDirectory = await mkdtemp(join(tmpdir(), "ppmcp-ledger-dispatch-failure-"));
    const adapter = new FakeAdapter("uxp", true, success);
    const firstLease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
    const firstEngine = new OperationEngine([adapter], {
      authorizationService: new AuthorizationService({ mode: "interactive", lease: firstLease }),
      pathPolicy: new PathPolicy([root]),
      ledger: new FailAfterPlannedLedger(ledgerDirectory),
    });

    const first = await firstEngine.execute({ actionId: "project.inspect", args: {}, operationId: "55555555-5555-4555-8555-555555555555" });

    expect(first).toMatchObject({ status: "reconciliation_required", error: { code: "LEDGER_RECORD_FAILED", retryable: false } });
    expect(adapter.calls).toHaveLength(1);
    const persisted = await readFile(join(ledgerDirectory, "ledger.jsonl"), "utf8");
    expect(persisted).toContain('"status":"planned"');
    expect(persisted).not.toContain('"status":"succeeded"');

    const restartedLease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
    const restarted = new OperationEngine([adapter], {
      authorizationService: new AuthorizationService({ mode: "interactive", lease: restartedLease }),
      pathPolicy: new PathPolicy([root]),
      ledger: new OperationLedger(ledgerDirectory),
    });
    const blocked = await restarted.execute({ actionId: "project.save", args: {}, operationId: "66666666-6666-4666-8666-666666666666" });

    expect(blocked).toMatchObject({ status: "blocked", error: { code: "RECONCILIATION_REQUIRED", retryable: true } });
    expect(adapter.calls).toHaveLength(1);
  });

  it("runs 100 trusted_unattended operations with zero confirmation calls and zero approval files", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-unattended-root-"));
    const approvalDirectory = await mkdtemp(join(tmpdir(), "ppmcp-unattended-approvals-"));
    const confirmations = new ConfirmationService(approvalDirectory, testApprovalAuthenticator);
    const issue = vi.spyOn(confirmations, "issue");
    const consume = vi.spyOn(confirmations, "consume");
    const authenticate = { sign: async (message: string) => createHash("sha256").update(message).digest("base64url"), verify: async (message: string, signature: string) => signature === createHash("sha256").update(message).digest("base64url") };
    const lease = await SessionLease.createForCurrentProcess({ authenticate });
    const profile: TrustProfile = {
      schemaVersion: 1, profileId: "unattended-test", mode: "trusted_unattended", riskCeiling: "R3", actionAllow: ["project.inspect"], actionDeny: [], approvedRoots: [root],
      capabilities: { overwrite: false, delete: false, thirdPartyPluginUi: false, cloudPublish: false, cloudShare: false, purchase: false },
      checkpoint: { beforeFirstMutation: true, beforeNonUndoable: true, intervalOperations: 1000, retainCount: 1 }, limits: { maxOperations: 100, maxRuntimeMinutes: 60 },
    };
    const adapter = new FakeAdapter("cep", true, success);
    const engine = new OperationEngine([adapter], { authorizationService: new AuthorizationService({ mode: "trusted_unattended", lease, profile, confirmations }), pathPolicy: new PathPolicy([root]), ledger: new OperationLedger(await mkdtemp(join(tmpdir(), "ppmcp-unattended-ledger-"))) });
    const results = await Promise.all(Array.from({ length: 100 }, () => engine.execute({ actionId: "project.inspect", args: {} })));
    expect(results.every((result) => result.status === "succeeded")).toBe(true);
    expect(issue).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(await readdir(approvalDirectory)).toEqual([]);
  });

  it("creates and verifies a checkpoint before the first trusted mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-engine-checkpoint-"));
    const projectPath = join(root, "active.prproj");
    await writeFile(projectPath, "saved-project", "utf8");
    const lease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
    const profile: TrustProfile = {
      schemaVersion: 1, profileId: "engine-checkpoint", mode: "trusted_unattended", riskCeiling: "R3", actionAllow: ["project.save"], actionDeny: [], approvedRoots: [root],
      capabilities: { overwrite: false, delete: false, thirdPartyPluginUi: false, cloudPublish: false, cloudShare: false, purchase: false },
      checkpoint: { beforeFirstMutation: true, beforeNonUndoable: false, intervalOperations: 100, retainCount: 2 },
    };
    const calls: BridgeRequest[] = [];
    const adapter: BackendAdapter = {
      backend: "cep",
      probe: async () => ({ backend: "cep", available: true, hostVersion: "26.3.2", hostSessionId: "checkpoint-session", capabilityFingerprint: "checkpoint-capabilities", operations: ["project.save", "project.checkpoint"] }),
      supports: async () => ({ supported: true, state: "implemented_unverified" }),
      availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async (request) => {
        calls.push(request);
        return request.operation === "project.checkpoint"
          ? { protocolVersion: 1, requestId: request.requestId, ok: true, dispatchState: "completed", result: { saved: true, projectPath } }
          : success(request);
      },
    };
    const engine = new OperationEngine([adapter], { authorizationService: new AuthorizationService({ mode: "trusted_unattended", lease, profile }), pathPolicy: new PathPolicy([root]), ledger: new OperationLedger(await mkdtemp(join(tmpdir(), "ppmcp-checkpoint-ledger-"))) });

    const result = await engine.execute({ actionId: "project.save", args: {} });

    expect(result.status).toBe("succeeded");
    expect(calls.map((call) => call.operation)).toEqual(["project.checkpoint", "project.checkpoint", "project.save"]);
    expect(calls.slice(0, 2).map((call) => (call.args.checkpoint as { phase: string }).phase)).toEqual(["inspect", "save"]);
    expect(calls[0]).toMatchObject({ planHash: calls[1]!.planHash, routeBinding: calls[1]!.routeBinding });
    const checkpoints = await readdir(join(root, ".premiere-mcp-checkpoints"));
    expect(checkpoints).toHaveLength(1);
    expect(await readFile(join(root, ".premiere-mcp-checkpoints", checkpoints[0]!), "utf8")).toBe("saved-project");
  });

  it("stops with a reconciliation-required ledger record when checkpoint outcome is unknown", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-engine-checkpoint-unknown-"));
    const lease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
    const profile: TrustProfile = {
      schemaVersion: 1, profileId: "checkpoint-unknown", mode: "trusted_unattended", riskCeiling: "R3", actionAllow: ["project.save"], actionDeny: [], approvedRoots: [root],
      capabilities: { overwrite: false, delete: false, thirdPartyPluginUi: false, cloudPublish: false, cloudShare: false, purchase: false },
      checkpoint: { beforeFirstMutation: true, beforeNonUndoable: false, intervalOperations: 100, retainCount: 1 },
    };
    const calls: BridgeRequest[] = [];
    const adapter: BackendAdapter = {
      backend: "cep",
      probe: async () => ({ backend: "cep", available: true, hostVersion: "26.3.2", operations: ["project.save", "project.checkpoint"] }),
      supports: async () => ({ supported: true, state: "implemented_unverified" }),
      availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async (request) => { calls.push(request); return { protocolVersion: 1, requestId: request.requestId, ok: false, dispatchState: "unknown", error: { code: "CHECKPOINT_TIMEOUT", message: "save outcome unknown", retryable: false } }; },
    };
    const ledgerDirectory = await mkdtemp(join(tmpdir(), "ppmcp-checkpoint-unknown-ledger-"));
    const engine = new OperationEngine([adapter], { authorizationService: new AuthorizationService({ mode: "trusted_unattended", lease, profile }), pathPolicy: new PathPolicy([root]), ledger: new OperationLedger(ledgerDirectory) });

    const result = await engine.execute({ actionId: "project.save", args: {} });

    expect(result).toMatchObject({ status: "reconciliation_required", error: { code: "CHECKPOINT_OUTCOME_UNKNOWN", retryable: false } });
    expect(calls.map((call) => call.operation)).toEqual(["project.checkpoint"]);
    const ledger = await readFile(join(ledgerDirectory, "ledger.jsonl"), "utf8");
    expect(ledger).toContain('"status":"reconciliation_required"');
  });

  it("holds a global mutation barrier until the first checkpoint is verified", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-engine-checkpoint-barrier-"));
    const projectPath = join(root, "active.prproj");
    await writeFile(projectPath, "saved-project", "utf8");
    const lease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
    const profile: TrustProfile = {
      schemaVersion: 1, profileId: "checkpoint-barrier", mode: "trusted_unattended", riskCeiling: "R3", actionAllow: ["project.save"], actionDeny: [], approvedRoots: [root],
      capabilities: { overwrite: false, delete: false, thirdPartyPluginUi: false, cloudPublish: false, cloudShare: false, purchase: false },
      checkpoint: { beforeFirstMutation: true, beforeNonUndoable: false, intervalOperations: 100, retainCount: 1 },
    };
    let checkpointEntered!: () => void;
    let releaseCheckpoint!: () => void;
    const checkpointEnteredPromise = new Promise<void>((resolve) => { checkpointEntered = resolve; });
    const releaseCheckpointPromise = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    const calls: BridgeRequest[] = [];
    const adapter: BackendAdapter = {
      backend: "uxp",
      probe: async () => ({ backend: "uxp", available: true, hostVersion: "26.3.2", hostSessionId: "barrier-session", capabilityFingerprint: "barrier-capabilities", operations: ["project.save", "project.checkpoint"] }),
      supports: async () => ({ supported: true, state: "implemented_unverified" }),
      availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async (request) => {
        calls.push(request);
        if (request.operation === "project.checkpoint") {
          checkpointEntered();
          await releaseCheckpointPromise;
          return { protocolVersion: 1, requestId: request.requestId, ok: true, dispatchState: "completed", result: { saved: true, projectPath } };
        }
        return success(request);
      },
    };
    const engine = new OperationEngine([adapter], { authorizationService: new AuthorizationService({ mode: "trusted_unattended", lease, profile }), pathPolicy: new PathPolicy([root]), ledger: new OperationLedger(await mkdtemp(join(tmpdir(), "ppmcp-checkpoint-barrier-ledger-"))) });

    const first = engine.execute({ actionId: "project.save", args: {}, operationId: "11111111-1111-4111-8111-111111111111" });
    await checkpointEnteredPromise;
    const blocked = await engine.execute({ actionId: "project.save", args: {}, operationId: "22222222-2222-4222-8222-222222222222" });

    expect(blocked).toMatchObject({ status: "blocked", error: { code: "CHECKPOINT_BARRIER_ACTIVE", retryable: true } });
    expect(calls.map((call) => call.operation)).toEqual(["project.checkpoint"]);
    releaseCheckpoint();
    await expect(first).resolves.toMatchObject({ status: "succeeded" });
    expect(calls.map((call) => call.operation)).toEqual(["project.checkpoint", "project.checkpoint", "project.save"]);
  });

  it("keeps unknown checkpoint reconciliation quarantined after an engine restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-engine-checkpoint-restart-"));
    const ledgerDirectory = await mkdtemp(join(tmpdir(), "ppmcp-checkpoint-restart-ledger-"));
    const profile: TrustProfile = {
      schemaVersion: 1, profileId: "checkpoint-restart", mode: "trusted_unattended", riskCeiling: "R3", actionAllow: ["project.save"], actionDeny: [], approvedRoots: [root],
      capabilities: { overwrite: false, delete: false, thirdPartyPluginUi: false, cloudPublish: false, cloudShare: false, purchase: false },
      checkpoint: { beforeFirstMutation: true, beforeNonUndoable: false, intervalOperations: 100, retainCount: 1 },
    };
    const calls: BridgeRequest[] = [];
    const adapter: BackendAdapter = {
      backend: "uxp",
      probe: async () => ({ backend: "uxp", available: true, hostVersion: "26.3.2", operations: ["project.save", "project.checkpoint"] }),
      supports: async () => ({ supported: true, state: "implemented_unverified" }),
      availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async (request) => {
        calls.push(request);
        return { protocolVersion: 1, requestId: request.requestId, ok: false, dispatchState: "unknown", error: { code: "CHECKPOINT_TIMEOUT", message: "unknown", retryable: false } };
      },
    };
    const firstLease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
    const firstEngine = new OperationEngine([adapter], { authorizationService: new AuthorizationService({ mode: "trusted_unattended", lease: firstLease, profile }), pathPolicy: new PathPolicy([root]), ledger: new OperationLedger(ledgerDirectory) });
    await expect(firstEngine.execute({ actionId: "project.save", args: {}, operationId: "33333333-3333-4333-8333-333333333333" })).resolves.toMatchObject({ status: "reconciliation_required" });

    const restartedLease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
    const restartedEngine = new OperationEngine([adapter], { authorizationService: new AuthorizationService({ mode: "trusted_unattended", lease: restartedLease, profile }), pathPolicy: new PathPolicy([root]), ledger: new OperationLedger(ledgerDirectory) });
    const blocked = await restartedEngine.execute({ actionId: "project.save", args: {}, operationId: "44444444-4444-4444-8444-444444444444" });

    expect(blocked).toMatchObject({ status: "blocked", error: { code: "RECONCILIATION_REQUIRED", retryable: true } });
    expect(calls.map((call) => call.operation)).toEqual(["project.checkpoint"]);
  });

  it("releases a not-dispatched checkpoint barrier and reauthorizes the fallback route", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-checkpoint-fallback-"));
    const projectPath = join(root, "active.prproj");
    await writeFile(projectPath, "saved-project", "utf8");
    const profile: TrustProfile = {
      schemaVersion: 1, profileId: "checkpoint-fallback", mode: "trusted_unattended", riskCeiling: "R3", actionAllow: ["project.save"], actionDeny: [], approvedRoots: [root],
      capabilities: { overwrite: false, delete: false, thirdPartyPluginUi: false, cloudPublish: false, cloudShare: false, purchase: false },
      checkpoint: { beforeFirstMutation: true, beforeNonUndoable: false, intervalOperations: 100, retainCount: 1 },
    };
    const uxpCalls: BridgeRequest[] = [];
    const cepCalls: BridgeRequest[] = [];
    const uxp: BackendAdapter = {
      backend: "uxp",
      probe: async () => ({ backend: "uxp", available: true, hostVersion: "26.3.2", hostSessionId: "uxp-checkpoint-fallback", capabilityFingerprint: "uxp-checkpoint-capabilities", operations: ["project.save", "project.checkpoint"] }),
      supports: async () => ({ supported: true, state: "implemented_unverified" }), availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async (request) => { uxpCalls.push(request); return { protocolVersion: 1, requestId: request.requestId, ok: false, dispatchState: "not_dispatched", error: { code: "UXP_PRE_SEND", message: "before send", retryable: true } }; },
    };
    const cep: BackendAdapter = {
      backend: "cep",
      probe: async () => ({ backend: "cep", available: true, hostVersion: "26.3.2", hostSessionId: "cep-checkpoint-fallback", capabilityFingerprint: "cep-checkpoint-capabilities", operations: ["project.save", "project.checkpoint"] }),
      supports: async () => ({ supported: true, state: "implemented_unverified" }), availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async (request) => {
        cepCalls.push(request);
        return request.operation === "project.checkpoint"
          ? { protocolVersion: 1, requestId: request.requestId, ok: true, dispatchState: "completed", result: { saved: true, projectPath } }
          : success(request);
      },
    };
    const lease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
    const engine = new OperationEngine([uxp, cep], { authorizationService: new AuthorizationService({ mode: "trusted_unattended", lease, profile }), pathPolicy: new PathPolicy([root]), ledger: new OperationLedger(await mkdtemp(join(tmpdir(), "ppmcp-checkpoint-fallback-ledger-"))) });

    const result = await engine.execute({ actionId: "project.save", args: {} });

    expect(result).toMatchObject({ status: "succeeded", backend: "cep" });
    expect(uxpCalls.map((call) => call.operation)).toEqual(["project.checkpoint"]);
    expect(cepCalls.map((call) => call.operation)).toEqual(["project.checkpoint", "project.checkpoint", "project.save"]);
    expect(uxpCalls[0]!.planHash).not.toBe(cepCalls[0]!.planHash);
  });

  it("exports overwrite through a verified temporary file and atomic replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-engine-overwrite-"));
    const outputPath = join(root, "render.mp4");
    const presetPath = join(root, "preset.epr");
    await writeFile(outputPath, "old-render", "utf8");
    await writeFile(presetPath, "preset", "utf8");
    const calls: BridgeRequest[] = [];
    const adapter: BackendAdapter = {
      backend: "uxp",
      probe: async () => ({ backend: "uxp", available: true, hostVersion: "26.3.2", operations: ["export.sequence"] }),
      supports: async () => ({ supported: true, state: "implemented_unverified" }),
      availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async (request) => {
        calls.push(request);
        expect(request.args).toMatchObject({ overwrite: false });
        expect(request.args.outputPath).not.toBe(outputPath);
        expect(request.effectiveRequestDigest).toBe(effectiveBridgeRequestDigest("export.sequence", request.args, request.expectedRevision));
        await writeFile(request.args.outputPath as string, "new-render", "utf8");
        return success(request);
      },
    };
    const approvalDirectory = await mkdtemp(join(tmpdir(), "ppmcp-overwrite-approval-"));
    const lease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
    const engine = new OperationEngine([adapter], { authorizationService: new AuthorizationService({ mode: "interactive", lease, confirmations: new ConfirmationService(approvalDirectory, testApprovalAuthenticator) }), pathPolicy: new PathPolicy([root]), ledger: new OperationLedger(await mkdtemp(join(tmpdir(), "ppmcp-overwrite-ledger-"))) });
    const approved = await confirm(engine, approvalDirectory, { actionId: "export.sequence", args: { outputPath, presetPath, overwrite: true } });

    const result = await engine.execute(approved);

    expect(result).toMatchObject({ status: "succeeded", createdFiles: [{ name: outputPath, verified: true }] });
    expect(await readFile(outputPath, "utf8")).toBe("new-render");
    expect((await readdir(root)).filter((name) => name.includes(".ppmcp-"))).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it.skipIf(process.platform !== "win32")("plans overwrite against the canonical Windows path identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-engine-overwrite-canonical-"));
    const actualOutputPath = join(root, "render.mp4");
    const actualPresetPath = join(root, "preset.epr");
    await writeFile(actualOutputPath, "old-render", "utf8");
    await writeFile(actualPresetPath, "preset", "utf8");
    const suppliedOutputPath = actualOutputPath.toUpperCase();
    const suppliedPresetPath = actualPresetPath.toUpperCase();
    const adapter: BackendAdapter = {
      backend: "uxp",
      probe: async () => ({ backend: "uxp", available: true, hostVersion: "26.3.2", operations: ["export.sequence"] }),
      supports: async () => ({ supported: true, state: "implemented_unverified" }),
      availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async (request) => {
        expect(request.effectiveRequestDigest).toBe(effectiveBridgeRequestDigest("export.sequence", request.args, request.expectedRevision));
        await writeFile(request.args.outputPath as string, "new-render", "utf8");
        return success(request);
      },
    };
    const approvalDirectory = await mkdtemp(join(tmpdir(), "ppmcp-overwrite-canonical-approval-"));
    const lease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
    const engine = new OperationEngine([adapter], { authorizationService: new AuthorizationService({ mode: "interactive", lease, confirmations: new ConfirmationService(approvalDirectory, testApprovalAuthenticator) }), pathPolicy: new PathPolicy([root]), ledger: new OperationLedger(await mkdtemp(join(tmpdir(), "ppmcp-overwrite-canonical-ledger-"))) });
    const approved = await confirm(engine, approvalDirectory, { actionId: "export.sequence", args: { outputPath: suppliedOutputPath, presetPath: suppliedPresetPath, overwrite: true } });

    const result = await engine.execute(approved);

    expect(result).toMatchObject({ status: "succeeded" });
    expect(await readFile(actualOutputPath, "utf8")).toBe("new-render");
  });

  it("restores the original export after a known temporary-output failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-engine-overwrite-failure-"));
    const outputPath = join(root, "render.mp4");
    const presetPath = join(root, "preset.epr");
    await writeFile(outputPath, "original-render", "utf8");
    await writeFile(presetPath, "preset", "utf8");
    const adapter: BackendAdapter = {
      backend: "uxp",
      probe: async () => ({ backend: "uxp", available: true, hostVersion: "26.3.2", operations: ["export.sequence"] }),
      supports: async () => ({ supported: true, state: "implemented_unverified" }),
      availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async (request) => {
        await writeFile(request.args.outputPath as string, "partial", "utf8");
        return { protocolVersion: 1, requestId: request.requestId, ok: false, dispatchState: "completed", error: { code: "ENCODER_FAILED", message: "known failure", retryable: false } };
      },
    };
    const approvalDirectory = await mkdtemp(join(tmpdir(), "ppmcp-overwrite-approval-"));
    const lease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
    const engine = new OperationEngine([adapter], { authorizationService: new AuthorizationService({ mode: "interactive", lease, confirmations: new ConfirmationService(approvalDirectory, testApprovalAuthenticator) }), pathPolicy: new PathPolicy([root]), ledger: new OperationLedger(await mkdtemp(join(tmpdir(), "ppmcp-overwrite-failure-ledger-"))) });
    const approved = await confirm(engine, approvalDirectory, { actionId: "export.sequence", args: { outputPath, presetPath, overwrite: true } });

    const result = await engine.execute(approved);

    expect(result).toMatchObject({ status: "failed", error: { code: "ENCODER_FAILED" } });
    expect(await readFile(outputPath, "utf8")).toBe("original-render");
    expect((await readdir(root)).filter((name) => name.includes(".ppmcp-"))).toEqual([]);
  });

  it("quarantines the same overwrite target across operation IDs and fresh ledgers", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-engine-overwrite-quarantine-"));
    const outputPath = join(root, "render.mp4");
    const presetPath = join(root, "preset.epr");
    await writeFile(outputPath, "original-render", "utf8");
    await writeFile(presetPath, "preset", "utf8");
    const firstCalls: BridgeRequest[] = [];
    const firstAdapter: BackendAdapter = {
      backend: "uxp",
      probe: async () => ({ backend: "uxp", available: true, hostVersion: "26.3.2", operations: ["export.sequence"] }),
      supports: async () => ({ supported: true, state: "implemented_unverified" }), availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async (request) => { firstCalls.push(request); return { protocolVersion: 1, requestId: request.requestId, ok: false, dispatchState: "unknown", error: { code: "ENCODER_DISCONNECTED", message: "outcome unknown", retryable: false } }; },
    };
    const firstApprovalDirectory = await mkdtemp(join(tmpdir(), "ppmcp-overwrite-quarantine-approval-"));
    const firstLease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
    const firstEngine = new OperationEngine([firstAdapter], { authorizationService: new AuthorizationService({ mode: "interactive", lease: firstLease, confirmations: new ConfirmationService(firstApprovalDirectory, testApprovalAuthenticator) }), pathPolicy: new PathPolicy([root]), ledger: new OperationLedger(await mkdtemp(join(tmpdir(), "ppmcp-overwrite-quarantine-ledger-"))) });
    const firstApproved = await confirm(firstEngine, firstApprovalDirectory, { actionId: "export.sequence", args: { outputPath, presetPath, overwrite: true } });
    await expect(firstEngine.execute(firstApproved)).resolves.toMatchObject({ status: "reconciliation_required" });
    expect(firstCalls).toHaveLength(1);

    const secondCalls: BridgeRequest[] = [];
    const secondAdapter: BackendAdapter = {
      ...firstAdapter,
      execute: async (request) => { secondCalls.push(request); return success(request); },
    };
    const secondApprovalDirectory = await mkdtemp(join(tmpdir(), "ppmcp-overwrite-quarantine-approval-"));
    const secondLease = await SessionLease.createForCurrentProcess({ authenticate: testLeaseAuthenticator });
    const secondEngine = new OperationEngine([secondAdapter], { authorizationService: new AuthorizationService({ mode: "interactive", lease: secondLease, confirmations: new ConfirmationService(secondApprovalDirectory, testApprovalAuthenticator) }), pathPolicy: new PathPolicy([root]), ledger: new OperationLedger(await mkdtemp(join(tmpdir(), "ppmcp-overwrite-quarantine-ledger-"))) });
    const secondApproved = await confirm(secondEngine, secondApprovalDirectory, { actionId: "export.sequence", args: { outputPath, presetPath, overwrite: true } });
    const blocked = await secondEngine.execute(secondApproved);

    expect(blocked).toMatchObject({ status: "reconciliation_required", error: { code: "OUTPUT_RECOVERY_QUARANTINED", retryable: false } });
    expect(secondCalls).toHaveLength(0);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    const quarantinedBackup = (await readdir(root)).find((name) => name.includes(".backup."));
    expect(quarantinedBackup).toBeDefined();
    expect(await readFile(join(root, quarantinedBackup!), "utf8")).toBe("original-render");
  });

  it("builds a new exact plan and reauthorizes trusted not_dispatched fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-trusted-fallback-"));
    const projectPath = join(root, "input.prproj");
    await writeFile(projectPath, "project", "utf8");
    const authenticate = { sign: async (message: string) => createHash("sha256").update(message).digest("base64url"), verify: async (message: string, signature: string) => signature === createHash("sha256").update(message).digest("base64url") };
    const lease = await SessionLease.createForCurrentProcess({ authenticate });
    const profile: TrustProfile = {
      schemaVersion: 1, profileId: "fallback-test", mode: "trusted_unattended", riskCeiling: "R3", actionAllow: ["project.open"], actionDeny: [], approvedRoots: [root],
      capabilities: { overwrite: false, delete: false, thirdPartyPluginUi: false, cloudPublish: false, cloudShare: false, purchase: false },
      checkpoint: { beforeFirstMutation: true, beforeNonUndoable: true, intervalOperations: 1000, retainCount: 1 }, limits: { maxOperations: 1, maxRuntimeMinutes: 60 },
    };
    const first = new FakeAdapter("uxp", true, (request) => ({ protocolVersion: 1, requestId: request.requestId, ok: false, dispatchState: "not_dispatched", error: { code: "PRE_SEND", message: "before send" } }));
    const second = new FakeAdapter("cep", true, success);
    const engine = new OperationEngine([first, second], { authorizationService: new AuthorizationService({ mode: "trusted_unattended", lease, profile }), pathPolicy: new PathPolicy([root]) });
    const result = await engine.execute({ actionId: "project.open", args: { path: projectPath } });
    expect(result).toMatchObject({ status: "succeeded", backend: "cep" });
    expect(first.calls[0]!.planHash).not.toBe(second.calls[0]!.planHash);
  });
});
