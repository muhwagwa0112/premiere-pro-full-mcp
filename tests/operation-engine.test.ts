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
  constructor(readonly backend: Backend, private readonly available: boolean, private readonly response: (request: BridgeRequest) => BridgeResponse) {}
  async availability() { return this.available ? { available: true, hostVersion: "26.3.2" } : { available: false, reason: "test unavailable" }; }
  async execute(request: BridgeRequest) { this.calls.push(request); return this.response(request); }
}

async function engineWith(adapters: BackendAdapter[]) {
  const directory = await mkdtemp(join(tmpdir(), "ppmcp-ledger-"));
  const approvalDirectory = await mkdtemp(join(tmpdir(), "ppmcp-approval-"));
  return { engine: new OperationEngine(adapters, { ledger: new OperationLedger(directory), confirmations: new ConfirmationService(approvalDirectory, testApprovalAuthenticator), pathPolicy: new PathPolicy(["C:\\approved"]) }), directory, approvalDirectory };
}

function success(request: BridgeRequest): BridgeResponse {
  return { protocolVersion: 1, requestId: request.requestId, ok: true, hostVersion: "26.3.2", afterRevision: "after", verification: { outcome: "verified", method: "test readback" }, result: { ok: true } };
}

async function confirm(engine: OperationEngine, approvalDirectory: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const preview = await engine.preview(request) as { approvalId: string };
  await approveForTest(preview.approvalId, approvalDirectory);
  return { ...request, approvalId: preview.approvalId };
}

describe("operation routing", () => {
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

  it("does not replay a failed mutation through another backend", async () => {
    const uxp = new FakeAdapter("uxp", true, (request) => ({ protocolVersion: 1, requestId: request.requestId, ok: false, error: { code: "UXP_FAILED", message: "partial state unknown", retryable: true } }));
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
    const cep = new FakeAdapter("cep", true, (request) => ({ protocolVersion: 1, requestId: request.requestId, ok: false, error: { code: "CEP_TIMEOUT", message: "read timed out", retryable: true } }));
    const { engine } = await engineWith([cep]);
    const result = await engine.execute({ actionId: "project.inspect", args: {} });
    expect(result.error).toMatchObject({ code: "CEP_TIMEOUT", retryable: true });
    expect(result.verification.outcome).toBe("failed");
  });

  it("marks mutation adapter exceptions as non-retryable unknown outcomes", async () => {
    const cep: BackendAdapter = {
      backend: "cep",
      availability: async () => ({ available: true, hostVersion: "26.3.2" }),
      execute: async () => { throw new Error("connection lost after dispatch"); },
    };
    const { engine, approvalDirectory } = await engineWith([cep]);
    const request = { actionId: "project.save", args: {} };
    const result = await engine.execute(await confirm(engine, approvalDirectory, request));
    expect(result.error).toMatchObject({ code: "OUTCOME_UNKNOWN", retryable: false });
    expect(result.warnings[0]).toContain("never retry");
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
