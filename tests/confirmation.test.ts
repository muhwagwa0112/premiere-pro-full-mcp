import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAction } from "../src/catalog.js";
import { ConfirmationService } from "../src/security/confirmation.js";
import type { ActionRequest } from "../src/contracts.js";
import { approveForTest, testApprovalAuthenticator } from "./test-approval.js";
import { buildExecutionPlan } from "../src/security/execution-plan.js";

describe("confirmation binding", () => {
  const request: ActionRequest = {
    actionId: "export.frame",
    args: { outputPath: "C:\\approved\\frame.png", timeSeconds: 1.25 },
    expectedRevision: "revision-1",
    operationId: "33333333-3333-4333-8333-333333333333",
  };

  const planFor = (hostSessionId = "host-session-1") => buildExecutionPlan({
    action: getAction(request.actionId), request,
    probe: { backend: "uxp", available: true, operations: [request.actionId], hostVersion: "26.3.2", hostSessionId, capabilityFingerprint: "cap-1" },
    approvedRootDigests: ["sha256:" + "a".repeat(64)],
  });

  it("binds a one-time out-of-band approval to action arguments and revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-approval-"));
    const service = new ConfirmationService(directory, testApprovalAuthenticator);
    const action = getAction(request.actionId);
    const plan = planFor();
    const issued = await service.issue(action, request, plan);
    expect(issued).not.toHaveProperty("token");
    const stored = await readFile(join(directory, `pending-${issued.approvalId}.json`), "utf8");
    expect(stored).not.toContain("C:\\approved\\frame.png");
    await approveForTest(issued.approvalId, directory);
    await service.consume(action, request, issued.approvalId, plan);
    await expect(service.consume(action, request, issued.approvalId, plan)).rejects.toThrow();
  });

  it("rejects argument or revision drift", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-approval-"));
    const service = new ConfirmationService(directory, testApprovalAuthenticator);
    const action = getAction(request.actionId);
    const plan = planFor();
    const issued = await service.issue(action, request, plan);
    await approveForTest(issued.approvalId, directory);
    await expect(service.consume(action, { ...request, args: { ...request.args, timeSeconds: 2 } }, issued.approvalId, plan)).rejects.toThrow(/does not match/);
    const second = await service.issue(action, request, plan);
    await approveForTest(second.approvalId, directory);
    await expect(service.consume(action, { ...request, expectedRevision: "revision-2" }, second.approvalId, plan)).rejects.toThrow();
  });

  it("allows exactly one concurrent consumer to claim an approved record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-approval-"));
    const service = new ConfirmationService(directory, testApprovalAuthenticator);
    const action = getAction(request.actionId);
    const plan = planFor();
    const issued = await service.issue(action, request, plan);
    await approveForTest(issued.approvalId, directory);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.consume(action, request, issued.approvalId, plan)),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(7);
  });

  it("binds v2 approval to operationId, planHash, and exact route", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-approval-"));
    const service = new ConfirmationService(directory, testApprovalAuthenticator);
    const action = getAction(request.actionId);
    const plan = planFor();
    const issued = await service.issue(action, request, plan);
    const pending = JSON.parse(await readFile(join(directory, `pending-${issued.approvalId}.json`), "utf8")) as { payload: string };
    const payload = JSON.parse(await testApprovalAuthenticator.unprotect(pending.payload)) as Record<string, unknown>;
    expect(payload).toMatchObject({ version: 2, operationId: request.operationId, planHash: plan.planHash, route: { backend: "uxp", hostSessionId: "host-session-1" } });
    await approveForTest(issued.approvalId, directory);
    await expect(service.consume(action, request, issued.approvalId, planFor("host-session-2"))).rejects.toThrow(/exact execution plan and route/);
  });
});
