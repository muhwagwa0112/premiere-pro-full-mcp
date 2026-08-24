import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getAction } from "../src/catalog.js";
import { AuthorizationService } from "../src/security/authorization-service.js";
import { buildExecutionPlan } from "../src/security/execution-plan.js";
import { SessionLease } from "../src/security/session-lease.js";
import { ConfirmationService } from "../src/security/confirmation.js";
import type { TrustProfile } from "../src/security/trust-profile.js";

const authenticate = { sign: async (message: string) => createHash("sha256").update(message).digest("base64url"), verify: async (message: string, signature: string) => signature === createHash("sha256").update(message).digest("base64url") };

describe("authorization service", () => {
  it("never falls back to confirmations and returns a plan-bound checkpoint grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-checkpoint-"));
    const lease = await SessionLease.createForCurrentProcess({ authenticate });
    const confirmations = new ConfirmationService(root);
    const issue = vi.spyOn(confirmations, "issue");
    const consume = vi.spyOn(confirmations, "consume");
    const profile: TrustProfile = {
      schemaVersion: 1, profileId: "checkpoint-test", mode: "trusted_unattended", riskCeiling: "R3", actionAllow: ["project.save"], actionDeny: [], approvedRoots: [root],
      capabilities: { overwrite: false, delete: false, thirdPartyPluginUi: false, cloudPublish: false, cloudShare: false, purchase: false },
      checkpoint: { beforeFirstMutation: true, beforeNonUndoable: true, intervalOperations: 100, retainCount: 1 },
    };
    const service = new AuthorizationService({ mode: "trusted_unattended", lease, profile, confirmations });
    const action = getAction("project.save");
    const request = { actionId: action.id, args: {}, operationId: "22222222-2222-4222-8222-222222222222" };
    const requirements = await service.executionRequirements(action);
    expect(requirements).toEqual({ checkpointRequired: true, checkpointRetention: 1 });
    const plan = buildExecutionPlan({ action, request, probe: { backend: "cep", available: true, operations: [action.id], hostVersion: "26.3.2" }, approvedRootDigests: [], checkpointRequired: true });
    const grant = await service.authorize(action, request, plan, []);
    expect(grant).toMatchObject({ checkpointRequired: true, checkpointRetention: 1 });
    expect(issue).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("rejects unattended mode/profile mismatch at construction", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-mode-"));
    const lease = await SessionLease.createForCurrentProcess({ authenticate });
    const profile: TrustProfile = { schemaVersion: 1, profileId: "interactive-test", mode: "interactive", riskCeiling: "R3", actionAllow: ["*"], actionDeny: [], approvedRoots: [root], capabilities: { overwrite: false, delete: false, thirdPartyPluginUi: false, cloudPublish: false, cloudShare: false, purchase: false }, checkpoint: { beforeFirstMutation: false, beforeNonUndoable: false, intervalOperations: 100, retainCount: 1 } };
    expect(() => new AuthorizationService({ mode: "trusted_unattended", lease, profile })).toThrow(/exact same mode/);
  });

  it.each([
    ["Project.deleteSequence", "delete"],
    ["SequenceEditor.createOverwriteItemAction", "overwrite"],
  ] as const)("derives %s capability requirements from trusted member metadata", async (memberId, capability) => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-capability-"));
    const lease = await SessionLease.createForCurrentProcess({ authenticate });
    const profile: TrustProfile = {
      schemaVersion: 1, profileId: "capability-test", mode: "trusted_unattended", riskCeiling: "R3", actionAllow: ["uxp.destructive"], actionDeny: [], approvedRoots: [root],
      capabilities: { overwrite: false, delete: false, thirdPartyPluginUi: false, cloudPublish: false, cloudShare: false, purchase: false },
      checkpoint: { beforeFirstMutation: false, beforeNonUndoable: false, intervalOperations: 100, retainCount: 1 },
    };
    const service = new AuthorizationService({ mode: "trusted_unattended", lease, profile });
    const action = getAction("uxp.destructive");
    const request = { actionId: action.id, args: { memberId, arguments: [] }, operationId: capability === "delete" ? "33333333-3333-4333-8333-333333333333" : "44444444-4444-4444-8444-444444444444" };
    const plan = buildExecutionPlan({ action, request, probe: { backend: "uxp", available: true, operations: [action.id], hostVersion: "26.3.2" }, approvedRootDigests: [] });
    await expect(service.authorize(action, request, plan, [])).rejects.toMatchObject({ code: "CAPABILITY_DENIED", message: expect.stringContaining(capability) });
  });

  it("requires a checkpoint for the first mutation even after a prior read", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-first-mutation-"));
    const lease = await SessionLease.createForCurrentProcess({ authenticate });
    const profile: TrustProfile = {
      schemaVersion: 1, profileId: "mutation-test", mode: "trusted_unattended", riskCeiling: "R3", actionAllow: ["host.inspect", "project.save"], actionDeny: [], approvedRoots: [root],
      capabilities: { overwrite: false, delete: false, thirdPartyPluginUi: false, cloudPublish: false, cloudShare: false, purchase: false },
      checkpoint: { beforeFirstMutation: true, beforeNonUndoable: false, intervalOperations: 100, retainCount: 1 },
    };
    const service = new AuthorizationService({ mode: "trusted_unattended", lease, profile });
    const readAction = getAction("host.inspect");
    const readRequest = { actionId: readAction.id, args: {}, operationId: "55555555-5555-4555-8555-555555555555" };
    const readPlan = buildExecutionPlan({ action: readAction, request: readRequest, probe: { backend: "local", available: true, operations: [readAction.id], hostVersion: "26.3.2" }, approvedRootDigests: [] });
    const readGrant = await service.authorize(readAction, readRequest, readPlan, []);
    service.markDispatched(readGrant);

    const mutationAction = getAction("project.save");
    const mutationRequest = { actionId: mutationAction.id, args: {}, operationId: "66666666-6666-4666-8666-666666666666" };
    expect(await service.executionRequirements(mutationAction)).toMatchObject({ checkpointRequired: true });
    const mutationPlan = buildExecutionPlan({ action: mutationAction, request: mutationRequest, probe: { backend: "cep", available: true, operations: [mutationAction.id], hostVersion: "26.3.2" }, approvedRootDigests: [], checkpointRequired: true });
    await expect(service.authorize(mutationAction, mutationRequest, mutationPlan, [])).resolves.toMatchObject({ checkpointRequired: true });
  });

  it("revalidates lease expiry immediately before dispatch", async () => {
    let now = 1_000;
    const lease = await SessionLease.createForCurrentProcess({ ttlMs: 100, now: () => now, pid: 42, processStartTime: 500, authenticate });
    const service = new AuthorizationService({ mode: "interactive", lease });
    const action = getAction("host.inspect");
    const request = { actionId: action.id, args: {}, operationId: "77777777-7777-4777-8777-777777777777" };
    const plan = buildExecutionPlan({ action, request, probe: { backend: "local", available: true, operations: [action.id], hostVersion: "26.3.2" }, approvedRootDigests: [] });
    const grant = await service.authorize(action, request, plan, []);
    now = 1_100;
    await expect(service.revalidateForDispatch(grant)).rejects.toMatchObject({ code: "SESSION_LEASE_INVALID" });
  });

  it("blocks later trusted mutation plans until the first checkpoint is verified", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-checkpoint-barrier-"));
    const lease = await SessionLease.createForCurrentProcess({ authenticate });
    const profile: TrustProfile = {
      schemaVersion: 1, profileId: "barrier-test", mode: "trusted_unattended", riskCeiling: "R3", actionAllow: ["project.save"], actionDeny: [], approvedRoots: [root],
      capabilities: { overwrite: false, delete: false, thirdPartyPluginUi: false, cloudPublish: false, cloudShare: false, purchase: false },
      checkpoint: { beforeFirstMutation: true, beforeNonUndoable: false, intervalOperations: 100, retainCount: 2 },
    };
    const service = new AuthorizationService({ mode: "trusted_unattended", lease, profile });
    const action = getAction("project.save");
    const firstRequest = { actionId: action.id, args: {}, operationId: "88888888-8888-4888-8888-888888888888" };
    const firstPlan = buildExecutionPlan({ action, request: firstRequest, probe: { backend: "cep", available: true, operations: [action.id], hostVersion: "26.3.2" }, approvedRootDigests: [], checkpointRequired: true });
    const firstGrant = await service.authorize(action, firstRequest, firstPlan, []);

    await expect(service.executionRequirements(action)).rejects.toMatchObject({ code: "CHECKPOINT_BARRIER_ACTIVE" });
    await expect(service.revalidateForDispatch(firstGrant)).rejects.toMatchObject({ code: "SESSION_LEASE_INVALID", message: expect.stringContaining("checkpoint barrier") });

    await service.completeCheckpoint(firstGrant);
    await expect(service.revalidateForDispatch(firstGrant)).resolves.toBeUndefined();
    await expect(service.executionRequirements(action)).resolves.toMatchObject({ checkpointRequired: false });
  });

  it("releases checkpoint failure without deadlock and requires the next exact mutation plan to checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-checkpoint-retry-"));
    const lease = await SessionLease.createForCurrentProcess({ authenticate });
    const profile: TrustProfile = {
      schemaVersion: 1, profileId: "barrier-retry", mode: "trusted_unattended", riskCeiling: "R3", actionAllow: ["project.save"], actionDeny: [], approvedRoots: [root],
      capabilities: { overwrite: false, delete: false, thirdPartyPluginUi: false, cloudPublish: false, cloudShare: false, purchase: false },
      checkpoint: { beforeFirstMutation: true, beforeNonUndoable: false, intervalOperations: 100, retainCount: 1 },
    };
    const service = new AuthorizationService({ mode: "trusted_unattended", lease, profile });
    const action = getAction("project.save");
    const firstRequest = { actionId: action.id, args: {}, operationId: "99999999-9999-4999-8999-999999999999" };
    const firstPlan = buildExecutionPlan({ action, request: firstRequest, probe: { backend: "cep", available: true, operations: [action.id], hostVersion: "26.3.2" }, approvedRootDigests: [], checkpointRequired: true });
    const firstGrant = await service.authorize(action, firstRequest, firstPlan, []);

    service.release(firstGrant, "not_dispatched");

    await expect(service.executionRequirements(action)).resolves.toMatchObject({ checkpointRequired: true });
    const retryRequest = { ...firstRequest, operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const retryPlan = buildExecutionPlan({ action, request: retryRequest, probe: { backend: "cep", available: true, operations: [action.id], hostVersion: "26.3.2" }, approvedRootDigests: [], checkpointRequired: true });
    await expect(service.authorize(action, retryRequest, retryPlan, [])).resolves.toMatchObject({ checkpointRequired: true, reservation: { mutationIndex: 0 } });
  });

  it("atomically gives only one concurrent first mutation the checkpoint barrier", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-checkpoint-race-"));
    const lease = await SessionLease.createForCurrentProcess({ authenticate });
    const profile: TrustProfile = {
      schemaVersion: 1, profileId: "barrier-race", mode: "trusted_unattended", riskCeiling: "R3", actionAllow: ["project.save"], actionDeny: [], approvedRoots: [root],
      capabilities: { overwrite: false, delete: false, thirdPartyPluginUi: false, cloudPublish: false, cloudShare: false, purchase: false },
      checkpoint: { beforeFirstMutation: true, beforeNonUndoable: false, intervalOperations: 100, retainCount: 1 },
    };
    const service = new AuthorizationService({ mode: "trusted_unattended", lease, profile });
    const action = getAction("project.save");
    const requests = [
      { actionId: action.id, args: {}, operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { actionId: action.id, args: {}, operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    ];
    const plans = requests.map((request) => buildExecutionPlan({ action, request, probe: { backend: "cep" as const, available: true, operations: [action.id], hostVersion: "26.3.2" }, approvedRootDigests: [], checkpointRequired: true }));

    const results = await Promise.allSettled(requests.map((request, index) => service.authorize(action, request, plans[index]!, [])));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "CHECKPOINT_BARRIER_ACTIVE" });
    const granted = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.authorize>>> => result.status === "fulfilled");
    service.release(granted!.value, "not_dispatched");
    await expect(service.executionRequirements(action)).resolves.toMatchObject({ checkpointRequired: true });
  });
});
