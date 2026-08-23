import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAction } from "../src/catalog.js";
import { ConfirmationService } from "../src/security/confirmation.js";
import type { ActionRequest } from "../src/contracts.js";
import { approveForTest, testApprovalAuthenticator } from "./test-approval.js";

describe("confirmation binding", () => {
  const request: ActionRequest = {
    actionId: "export.frame",
    args: { outputPath: "C:\\approved\\frame.png", timeSeconds: 1.25 },
    expectedRevision: "revision-1",
  };

  it("binds a one-time out-of-band approval to action arguments and revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-approval-"));
    const service = new ConfirmationService(directory, testApprovalAuthenticator);
    const action = getAction(request.actionId);
    const issued = await service.issue(action, request);
    expect(issued).not.toHaveProperty("token");
    const stored = await readFile(join(directory, `pending-${issued.approvalId}.json`), "utf8");
    expect(stored).not.toContain("C:\\approved\\frame.png");
    await approveForTest(issued.approvalId, directory);
    await service.consume(action, request, issued.approvalId);
    await expect(service.consume(action, request, issued.approvalId)).rejects.toThrow();
  });

  it("rejects argument or revision drift", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-approval-"));
    const service = new ConfirmationService(directory, testApprovalAuthenticator);
    const action = getAction(request.actionId);
    const issued = await service.issue(action, request);
    await approveForTest(issued.approvalId, directory);
    await expect(service.consume(action, { ...request, args: { ...request.args, timeSeconds: 2 } }, issued.approvalId)).rejects.toThrow(/does not match/);
    const second = await service.issue(action, request);
    await approveForTest(second.approvalId, directory);
    await expect(service.consume(action, { ...request, expectedRevision: "revision-2" }, second.approvalId)).rejects.toThrow();
  });

  it("allows exactly one concurrent consumer to claim an approved record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-approval-"));
    const service = new ConfirmationService(directory, testApprovalAuthenticator);
    const action = getAction(request.actionId);
    const issued = await service.issue(action, request);
    await approveForTest(issued.approvalId, directory);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => service.consume(action, request, issued.approvalId)),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(7);
  });
});
