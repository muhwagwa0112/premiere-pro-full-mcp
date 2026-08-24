import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActionRequest, OperationResult } from "../src/contracts.js";
import { JobEngine } from "../src/workflows/job-engine.js";
import { JobStore } from "../src/workflows/job-store.js";
import { testApprovalAuthenticator } from "./test-approval.js";

function result(request: ActionRequest, options: { status?: OperationResult["status"]; verified?: boolean; undo?: boolean; code?: string } = {}): OperationResult {
  const status = options.status ?? "succeeded";
  return {
    operationId: request.operationId!,
    actionId: request.actionId,
    status,
    backend: "cep",
    hostVersion: "26.3.2",
    risk: request.actionId === "host.inspect" ? "R0" : "R2",
    beforeRevision: request.expectedRevision ?? "before",
    afterRevision: "after",
    verification: status === "succeeded"
      ? { outcome: options.verified === false ? "committed_unverified" : "verified", method: "test verifier" }
      : { outcome: "failed", method: "test verifier" },
    undo: { available: options.undo ?? request.actionId !== "host.inspect", method: options.undo ?? request.actionId !== "host.inspect" ? "Premiere undo history" : null },
    createdFiles: [],
    warnings: [],
    ...(status !== "succeeded" ? { error: { code: options.code ?? "KNOWN_FAILURE", message: "known failure", retryable: true } } : {}),
  };
}

describe("durable job engine", () => {
  it("persists DAG step state and resume skips only verified completed steps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-jobs-resume-"));
    const calls: string[] = [];
    let secondAttempts = 0;
    const operations = { execute: async (request: ActionRequest) => {
      calls.push(request.actionId);
      if (request.actionId === "project.save" && secondAttempts++ === 0) return result(request, { status: "failed" });
      return result(request);
    } };
    const first = new JobEngine(operations, { directory, protector: testApprovalAuthenticator });
    const planned = await first.plan({ steps: [
      { stepId: "inspect", request: { actionId: "host.inspect", args: {} } },
      { stepId: "save", dependsOn: ["inspect"], request: { actionId: "project.save", args: {} } },
    ] });
    expect((await first.execute(planned.jobId)).status).toBe("failed");

    const afterRestart = new JobEngine(operations, { directory, protector: testApprovalAuthenticator });
    const resumed = await afterRestart.resume(planned.jobId);
    expect(resumed.status).toBe("succeeded");
    expect(resumed.steps.map((step) => [step.stepId, step.status, step.attempts])).toEqual([
      ["inspect", "succeeded", 1],
      ["save", "succeeded", 2],
    ]);
    expect(calls).toEqual(["host.inspect", "project.save", "project.save"]);
    expect((await afterRestart.status(planned.jobId))).toMatchObject({ status: "succeeded" });
  });

  it("applies cancellation only at the explicit before-step-dispatch boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-jobs-cancel-"));
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => { entered = resolve; });
    const calls: string[] = [];
    const operations = { execute: async (request: ActionRequest) => {
      calls.push(request.actionId);
      entered();
      await started;
      return result(request);
    } };
    const jobs = new JobEngine(operations, { directory, protector: testApprovalAuthenticator });
    const planned = await jobs.plan({ steps: [
      { stepId: "one", request: { actionId: "host.inspect", args: {} } },
      { stepId: "two", dependsOn: ["one"], request: { actionId: "host.inspect", args: {} } },
    ] });
    const execution = jobs.execute(planned.jobId);
    await didEnter;
    const pending = await jobs.cancel(planned.jobId);
    expect(pending.status).toBe("cancel_pending");
    expect(pending.cancellation.boundary).toBe("before_step_dispatch");
    release();
    const cancelled = await execution;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.steps[0]).toMatchObject({ status: "succeeded" });
    expect(cancelled.steps[1]).toMatchObject({ status: "pending", attempts: 0 });
    expect(calls).toEqual(["host.inspect"]);
    const journalPath = join(directory, `${planned.jobId}.jsonl`);
    const beforeRepeatedCancel = await readFile(journalPath, "utf8");
    expect((await jobs.cancel(planned.jobId)).status).toBe("cancelled");
    expect(await readFile(journalPath, "utf8")).toBe(beforeRepeatedCancel);
    await Promise.all(Array.from({ length: 100 }, () => jobs.cancel(planned.jobId)));
    expect(await readFile(journalPath, "utf8")).toBe(beforeRepeatedCancel);
  });

  it("rolls verified undoable mutations back in reverse DAG order using explicit requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-jobs-rollback-"));
    const operationIds: string[] = [];
    const operations = { execute: async (request: ActionRequest) => {
      operationIds.push(request.operationId!);
      return result(request, { undo: request.actionId === "project.save" });
    } };
    const jobs = new JobEngine(operations, { directory, protector: testApprovalAuthenticator });
    const planned = await jobs.plan({ steps: [
      { stepId: "first", request: { actionId: "project.save", args: {} }, rollbackRequest: { actionId: "history.undo", args: {} } },
      { stepId: "second", dependsOn: ["first"], request: { actionId: "project.save", args: {} }, rollbackRequest: { actionId: "history.undo", args: {} } },
    ] });
    expect((await jobs.execute(planned.jobId)).status).toBe("succeeded");
    const rolledBack = await jobs.rollback(planned.jobId);
    expect(rolledBack.status).toBe("rolled_back");
    expect(rolledBack.steps.map((step) => step.status)).toEqual(["rolled_back", "rolled_back"]);
    expect(operationIds.slice(2)).toEqual([
      planned.steps[1]!.rollbackRequest!.operationId,
      planned.steps[0]!.rollbackRequest!.operationId,
    ]);
  });

  it("blocks rollback without verified completion and undo evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-jobs-rollback-proof-"));
    const operations = { execute: async (request: ActionRequest) => result(request, { undo: false }) };
    const jobs = new JobEngine(operations, { directory, protector: testApprovalAuthenticator });
    const planned = await jobs.plan({ steps: [{ stepId: "save", request: { actionId: "project.save", args: {} }, rollbackRequest: { actionId: "history.undo", args: {} } }] });
    expect((await jobs.execute(planned.jobId)).status).toBe("succeeded");
    await expect(jobs.rollback(planned.jobId)).resolves.toMatchObject({ status: "succeeded", error: { code: "ROLLBACK_EVIDENCE_INSUFFICIENT" } });
  });

  it("quarantines a persisted running step after process restart instead of replaying it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-jobs-crash-"));
    const store = new JobStore(directory, testApprovalAuthenticator);
    const jobs = new JobEngine({ execute: async (request: ActionRequest) => result(request) }, { store });
    const planned = await jobs.plan({ steps: [{ stepId: "save", request: { actionId: "project.save", args: {} } }] });
    await store.update(planned.jobId, (job) => ({ ...job, status: "running", steps: job.steps.map((step) => ({ ...step, status: "running" })) }));

    const restarted = new JobEngine({ execute: async () => { throw new Error("must not replay"); } }, { directory, protector: testApprovalAuthenticator });
    await expect(restarted.status(planned.jobId)).resolves.toMatchObject({
      status: "reconciliation_required",
      steps: [{ status: "reconciliation_required" }],
      error: { code: "INTERRUPTED_DISPATCH_BOUNDARY" },
    });
    await expect(restarted.resume(planned.jobId)).resolves.toMatchObject({ error: { code: "JOB_RECONCILIATION_REQUIRED" } });
  });

  it("rejects cycles before persisting a plan", async () => {
    const jobs = new JobEngine({ execute: async (request: ActionRequest) => result(request) }, { directory: await mkdtemp(join(tmpdir(), "ppmcp-jobs-cycle-")), protector: testApprovalAuthenticator });
    await expect(jobs.plan({ steps: [
      { stepId: "a", dependsOn: ["b"], request: { actionId: "host.inspect", args: {} } },
      { stepId: "b", dependsOn: ["a"], request: { actionId: "host.inspect", args: {} } },
    ] })).rejects.toThrow(/cycle/);
  });

  it("validates action arguments before persistence and keeps journal payloads protected", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-jobs-protected-"));
    const jobs = new JobEngine({ execute: async (request: ActionRequest) => result(request) }, { directory, protector: testApprovalAuthenticator });
    await expect(jobs.plan({ steps: [{ stepId: "bad", request: { actionId: "project.save", args: { leakedPath: "C:\\private\\secret.prproj" } } }] })).rejects.toThrow();
    const planned = await jobs.plan({ steps: [{ stepId: "ok", request: { actionId: "project.save_as", args: { path: "C:\\private\\secret.prproj", overwrite: false }, expectedRevision: "revision-1" } }] });
    const journal = await readFile(join(directory, `${planned.jobId}.jsonl`), "utf8");
    expect(journal).not.toContain("secret.prproj");
    expect(journal).not.toContain("project.save_as");
  });

  it("enforces cross-process global job-store quota metadata", async () => {
    const source = await readFile(new URL("../src/workflows/job-store.ts", import.meta.url), "utf8");
    expect(source).toContain("MAX_DIRECTORY_BYTES = 256 * 1024 * 1024");
    expect(source).toContain("MAX_JOB_FILES = 1024");
    expect(source).toContain('open(lockPath, "wx"');
  });

  it("rebinds a dependent project-scoped request to its predecessor verified revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-jobs-revision-chain-"));
    const revisions: Array<string | undefined> = [];
    let call = 0;
    const jobs = new JobEngine({ execute: async (request: ActionRequest) => {
      revisions.push(request.expectedRevision);
      const response = result(request);
      return { ...response, afterRevision: `revision-${++call}` };
    } }, { directory, protector: testApprovalAuthenticator });
    const planned = await jobs.plan({ steps: [
      { stepId: "first", request: { actionId: "project.save", args: {}, expectedRevision: "revision-0" } },
      { stepId: "second", dependsOn: ["first"], request: { actionId: "project.close_disposable", args: { path: "C:\\fixture\\working.prproj", saveBeforeClose: true }, expectedRevision: "stale-revision" } },
    ] });
    expect((await jobs.execute(planned.jobId)).status).toBe("succeeded");
    expect(revisions).toEqual(["revision-0", "revision-1"]);
  });

  it("rejects dependent semantic-handle mutations until an explicit handle refresh contract exists", async () => {
    const jobs = new JobEngine({ execute: async (request: ActionRequest) => result(request) }, { directory: await mkdtemp(join(tmpdir(), "ppmcp-jobs-stale-handle-")), protector: testApprovalAuthenticator });
    const handle = { $ref: "handle-12345678", type: "Sequence", session: "session-12345678", stateToken: "semantic-v1-handle-token-12345678" };
    await expect(jobs.plan({ steps: [
      { stepId: "first", request: { actionId: "timeline.track.set_mute", args: { sequence: handle, mediaType: "video", trackIndex: 0, muted: true }, expectedRevision: "revision-0" } },
      { stepId: "second", dependsOn: ["first"], request: { actionId: "timeline.track.set_mute", args: { sequence: handle, mediaType: "video", trackIndex: 0, muted: false }, expectedRevision: "revision-0" } },
    ] })).rejects.toThrow(/refreshed semantic handle/);
  });
});
