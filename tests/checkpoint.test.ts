import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BridgeRequest, BridgeResponse } from "../src/contracts.js";
import type { ExecutionPlan } from "../src/security/execution-plan.js";
import { createCheckpoint, dispatchAfterCheckpoint } from "../src/workflows/checkpoint.js";

function plan(): ExecutionPlan {
  return {
    schemaVersion: 1, planId: "11111111-1111-4111-8111-111111111111", operationId: "11111111-1111-4111-8111-111111111111", jobId: null,
    actionId: "project.save", backend: "cep", hostVersion: "26.3.2", hostSessionId: "session-a", capabilityFingerprint: "fingerprint-a", risk: "R2",
    normalizedRequestDigest: `sha256:${"a".repeat(64)}`, effectiveRequestDigest: `sha256:${"c".repeat(64)}`, approvedRootDigests: [], expectedStateToken: null, preconditions: [], verification: ["checkpoint"], checkpointRequired: true, planHash: `sha256:${"b".repeat(64)}`,
  };
}

function response(request: BridgeRequest, projectPath: string): BridgeResponse {
  return { protocolVersion: 1, requestId: request.requestId, ok: true, dispatchState: "completed", result: { saved: true, projectPath } };
}

describe("checkpoint workflow", () => {
  it("saves through the selected exact route then makes a verified sibling checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-checkpoint-"));
    const projectPath = join(root, "edit.prproj");
    await writeFile(projectPath, "project bytes", "utf8");
    const calls: BridgeRequest[] = [];

    const checkpoint = await createCheckpoint({ dispatch: { execute: async (request) => { calls.push(request); return response(request, projectPath); } }, plan: plan(), approvedRoots: [root], retention: 2, now: () => new Date("2026-01-02T03:04:05.678Z") });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ operation: "project.checkpoint", planHash: plan().planHash, routeBinding: { backend: "cep", hostVersion: "26.3.2", hostSessionId: "session-a", capabilityFingerprint: "fingerprint-a" }, args: { checkpoint: { phase: "inspect", planHash: plan().planHash } } });
    expect(calls[1]).toMatchObject({ operation: "project.checkpoint", args: { checkpoint: { phase: "save", planHash: plan().planHash, expectedProjectPath: projectPath } } });
    expect(checkpoint.checkpointPath).toContain(".premiere-mcp-checkpoints");
    expect(checkpoint.bytes).toBe("project bytes".length);
    expect(await readFile(checkpoint.checkpointPath, "utf8")).toBe("project bytes");
  });

  it("fails closed for an unapproved or unavailable active project path", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-checkpoint-approved-"));
    const outside = await mkdtemp(join(tmpdir(), "ppmcp-checkpoint-outside-"));
    const projectPath = join(outside, "edit.prproj");
    await writeFile(projectPath, "project bytes", "utf8");
    let mutationCalls = 0;

    const phases: unknown[] = [];
    await expect(dispatchAfterCheckpoint({ dispatch: { execute: async (request) => { phases.push((request.args.checkpoint as { phase?: unknown }).phase); return response(request, projectPath); } }, plan: plan(), approvedRoots: [root], retention: 1 }, async () => { mutationCalls++; return "dispatched"; })).rejects.toMatchObject({ code: "CHECKPOINT_PATH_UNAPPROVED" });

    expect(mutationCalls).toBe(0);
    expect(phases).toEqual(["inspect"]);
  });

  it("does not dispatch the protected mutation after a failed or unknown checkpoint route", async () => {
    let mutationCalls = 0;
    await expect(dispatchAfterCheckpoint({ dispatch: { execute: async (request) => ({ protocolVersion: 1, requestId: request.requestId, ok: false, dispatchState: "unknown", error: { code: "TIMEOUT", message: "unknown", retryable: false } }) }, plan: plan(), approvedRoots: ["C:\\approved"], retention: 1 }, async () => { mutationCalls++; return "dispatched"; })).rejects.toMatchObject({ code: "CHECKPOINT_OUTCOME_UNKNOWN", dispatchState: "unknown" });
    expect(mutationCalls).toBe(0);
  });

  it("keeps UXP and CEP internal checkpoint handlers route-bound and fail-closed", async () => {
    const [uxp, cep] = await Promise.all([readFile("uxp-plugin/main.cjs", "utf8"), readFile("cep-plugin/host.jsx", "utf8")]);
    expect(uxp).toContain('"project.checkpoint"');
    expect(uxp).toContain("validateCheckpointBinding(message)");
    expect(uxp).toContain("UXP_CHECKPOINT_PROJECT_PATH_UNAVAILABLE");
    expect(uxp).toContain("UXP_CHECKPOINT_PROJECT_IDENTITY_DRIFT");
    expect(cep).toContain('request.operation === "project.checkpoint"');
    expect(cep).toContain("CEP_CHECKPOINT_ROUTE_BINDING_INVALID");
    expect(cep).toContain("CEP_CHECKPOINT_PROJECT_PATH_UNAVAILABLE");
    expect(cep).toContain("CEP_CHECKPOINT_PROJECT_IDENTITY_DRIFT");
  });
});
