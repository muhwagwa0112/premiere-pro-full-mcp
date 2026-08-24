import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Backend, BackendAdapter, BridgeRequest, BridgeResponse } from "../src/contracts.js";
import { OperationEngine } from "../src/operation-engine.js";
import { OperationLedger } from "../src/ledger.js";
import { PathPolicy } from "../src/security/path-policy.js";
import { ConfirmationService } from "../src/security/confirmation.js";
import { approveForTest, testApprovalAuthenticator } from "./test-approval.js";

class FakeAdapter implements BackendAdapter {
  calls: BridgeRequest[] = [];
  supportCalls: string[] = [];
  constructor(readonly backend: Backend, private readonly available: boolean, private readonly response: (request: BridgeRequest) => BridgeResponse, private readonly supported = true) {}
  async probe() { return { backend: this.backend, available: this.available, hostVersion: "26.3.2", operations: this.supported ? ["test-advertised"] : [], ...(this.available ? {} : { reason: "test unavailable" }) }; }
  async supports(operation: string) { this.supportCalls.push(operation); return this.supported ? { supported: true as const, state: "implemented_unverified" as const } : { supported: false as const, state: "unsupported" as const, reason: "test unsupported" }; }
  async availability() { return this.available ? { available: true, hostVersion: "26.3.2" } : { available: false, reason: "test unavailable" }; }
  async execute(request: BridgeRequest) { this.calls.push(request); return this.response(request); }
}

async function engineWith(adapters: BackendAdapter[]) {
  const directory = await mkdtemp(join(tmpdir(), "ppmcp-ledger-"));
  const approvalDirectory = await mkdtemp(join(tmpdir(), "ppmcp-approval-"));
  return { engine: new OperationEngine(adapters, { ledger: new OperationLedger(directory), confirmations: new ConfirmationService(approvalDirectory, testApprovalAuthenticator), pathPolicy: new PathPolicy(["C:\\approved"]) }), directory, approvalDirectory };
}

function success(request: BridgeRequest): BridgeResponse {
  return { protocolVersion: 1, requestId: request.requestId, ok: true, dispatchState: "completed", hostVersion: "26.3.2", afterRevision: "after", verification: { outcome: "verified", method: "test readback" }, result: { ok: true } };
}

async function confirm(engine: OperationEngine, approvalDirectory: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const preview = await engine.preview(request) as { approvalId: string };
  await approveForTest(preview.approvalId, approvalDirectory);
  return { ...request, approvalId: preview.approvalId };
}

describe("operation routing", () => {
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
    expect(uxp.supportCalls).toEqual(["project.save"]);
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

  it("does not apply a consumed interactive approval to a fallback backend", async () => {
    const uxp = new FakeAdapter("uxp", true, (request) => ({ protocolVersion: 1, requestId: request.requestId, ok: false, dispatchState: "not_dispatched", error: { code: "PRE_SEND_FAILURE", message: "socket closed before send", retryable: true } }));
    const cep = new FakeAdapter("cep", true, success);
    const { engine, approvalDirectory } = await engineWith([uxp, cep]);
    const request = { actionId: "project.save", args: {} };
    const result = await engine.execute(await confirm(engine, approvalDirectory, request));
    expect(result).toMatchObject({ status: "blocked", backend: "uxp", error: { code: "ROUTE_REAUTHORIZATION_REQUIRED", retryable: false } });
    expect(uxp.calls).toHaveLength(1);
    expect(cep.calls).toHaveLength(0);
  });

  it("does not replay a failed mutation through another backend", async () => {
    const uxp = new FakeAdapter("uxp", true, (request) => ({ protocolVersion: 1, requestId: request.requestId, ok: false, dispatchState: "unknown", error: { code: "UXP_FAILED", message: "partial state unknown", retryable: true } }));
    const cep = new FakeAdapter("cep", true, success);
    const { engine, approvalDirectory } = await engineWith([uxp, cep]);
    const request = { actionId: "project.save", args: {} };
    const result = await engine.execute(await confirm(engine, approvalDirectory, request));
    expect(result.status).toBe("failed");
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
    expect(result.status).toBe("failed");
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
    const preview = await engine.preview(request) as { approvalId: string };
    await approveForTest(preview.approvalId, approvalDirectory);
    const result = await engine.execute({ ...request, approvalId: preview.approvalId });
    expect(result.status).toBe("succeeded");
    expect(cep.calls).toHaveLength(1);
  });

  it("does not consume a one-shot approval while every backend is unavailable", async () => {
    const uxp = new FakeAdapter("uxp", false, success);
    const { engine, approvalDirectory } = await engineWith([uxp]);
    const request = { actionId: "export.frame", args: { outputPath: "C:\\approved\\frame.png", timeSeconds: 1 } };
    const preview = await engine.preview(request) as { approvalId: string };
    await approveForTest(preview.approvalId, approvalDirectory);

    const result = await engine.execute({ ...request, approvalId: preview.approvalId });

    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("NO_BACKEND_AVAILABLE");
    await expect(stat(join(approvalDirectory, `approved-${preview.approvalId}.json`))).resolves.toBeDefined();
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
    const engine = new OperationEngine([uxp], {
      ledger: new OperationLedger(ledgerDirectory),
      confirmations: new ConfirmationService(approvalDirectory, testApprovalAuthenticator),
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
});
