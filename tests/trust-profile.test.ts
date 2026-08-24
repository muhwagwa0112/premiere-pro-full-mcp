import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AuthorizationPolicy, type AuthorizationPlan } from "../src/security/authorization-policy.js";
import { BrokerTrustProfileStore } from "../src/security/trust-profile-store.js";
import { parseTrustProfile, type TrustProfile } from "../src/security/trust-profile.js";

const fixtureRoot = mkdtempSync(join(tmpdir(), "ppmcp-policy-"));
const approvedRoot = join(fixtureRoot, "approved");
const outsideRoot = join(fixtureRoot, "outside");
mkdirSync(approvedRoot);
mkdirSync(outsideRoot);
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const profile: TrustProfile = {
  schemaVersion: 1, profileId: "studio-unattended", mode: "trusted_unattended",
  premiereVersions: ["26.3.*"], riskCeiling: "R2", actionAllow: ["project.*", "export.*"], actionDeny: [],
  approvedRoots: [approvedRoot],
  capabilities: { overwrite: true, delete: false, thirdPartyPluginUi: false, cloudPublish: false, cloudShare: false, purchase: false },
  checkpoint: { beforeFirstMutation: true, beforeNonUndoable: true, intervalOperations: 50, retainCount: 10 },
  limits: { maxOperations: 100, maxRuntimeMinutes: 60 }, unexpectedModalPolicy: "pause_and_report",
};

function plan(actionId: "project.open" | "project.save", overrides: Partial<AuthorizationPlan> = {}): AuthorizationPlan {
  const isOpen = actionId === "project.open";
  return {
    actionId, risk: "R2", authority: isOpen ? "filesystem" : "edit", paths: isOpen ? [join(approvedRoot, "job", "input.prproj")] : [],
    mutation: !isOpen, nonUndoable: !isOpen, overwrite: false, delete: false, thirdPartyPluginUi: false,
    cloudPublish: false, cloudShare: false, purchase: false, ...overrides,
  };
}
const lease = { leaseId: "lease-1", hostVersion: "26.3.2", operationIndex: 1, elapsedRuntimeMinutes: 1 };

describe("trust profiles", () => {
  it("accepts only the three fixed modes and rejects unknown properties", () => {
    for (const mode of ["interactive", "trusted_unattended", "isolated_lab"] as const) expect(parseTrustProfile({ ...profile, mode }).mode).toBe(mode);
    expect(() => parseTrustProfile({ ...profile, mode: "unrestricted" })).toThrow();
    expect(() => parseTrustProfile({ ...profile, bypassPolicy: true })).toThrow();
  });

  it("exposes only the pinned read-only runtime broker API", async () => {
    const invoke = vi.fn(async () => JSON.stringify(profile));
    const store = new BrokerTrustProfileStore(invoke);
    expect(await store.load(profile.profileId)).toEqual(profile);
    expect(invoke).toHaveBeenCalledWith(["--trust-profile", "read", "node-server", profile.profileId], "");
    expect("save" in store).toBe(false);
  });

  it("fails closed when broker output is malformed or schema-tampered", async () => {
    await expect(new BrokerTrustProfileStore(async () => "not-json").load(profile.profileId)).rejects.toThrow("invalid profile");
    await expect(new BrokerTrustProfileStore(async () => JSON.stringify({ ...profile, schemaVersion: 2 })).load(profile.profileId)).rejects.toThrow("invalid profile");
  });
});

describe("authorization policy", () => {
  it("requires a catalog-bound complete strict plan before interactive fallback", async () => {
    const policy = new AuthorizationPolicy({ ...profile, mode: "interactive" });
    expect((await policy.authorize(plan("project.open"), lease)).outcome).toBe("interactive_required");
    expect(await policy.authorize({ ...plan("project.open"), risk: "R9" }, lease)).toMatchObject({ code: "INVALID_PLAN" });
    const { overwrite: _, ...missingBoolean } = plan("project.open");
    expect(await policy.authorize(missingBoolean, lease)).toMatchObject({ code: "INVALID_PLAN" });
    expect(await policy.authorize({ ...plan("project.open"), injected: true }, lease)).toMatchObject({ code: "INVALID_PLAN" });
    expect(await policy.authorize({ ...plan("project.open"), risk: "R1" }, lease)).toMatchObject({ code: "PLAN_CATALOG_MISMATCH" });
    expect(await policy.authorize({ ...plan("project.open"), authority: "edit", paths: [] }, lease)).toMatchObject({ code: "PLAN_CATALOG_MISMATCH" });
  });

  it("allows canonical non-existent children and requests configured checkpoints", async () => {
    const policy = new AuthorizationPolicy(profile);
    expect(await policy.authorize(plan("project.open"), lease)).toEqual({ outcome: "allow", profileId: profile.profileId, leaseId: "lease-1" });
    expect((await policy.authorize(plan("project.save"), { ...lease, operationIndex: 0, mutationIndex: 0 })).outcome).toBe("allow_with_checkpoint");
  });

  it("denies action, capability, risk, and canonical path violations", async () => {
    expect(await new AuthorizationPolicy({ ...profile, actionDeny: ["project.open"] }).authorize(plan("project.open"), lease)).toMatchObject({ code: "ACTION_DENIED" });
    expect(await new AuthorizationPolicy({ ...profile, riskCeiling: "R1" }).authorize(plan("project.open"), lease)).toMatchObject({ code: "RISK_CEILING_EXCEEDED" });
    expect(await new AuthorizationPolicy(profile).authorize(plan("project.open", { paths: [join(outsideRoot, "file.prproj")] }), lease)).toMatchObject({ code: "PATH_DENIED" });
    expect(await new AuthorizationPolicy(profile).authorize(plan("project.open", { delete: true }), lease)).toMatchObject({ code: "CAPABILITY_DENIED" });
    expect(await new AuthorizationPolicy(profile).authorize(plan("project.open", { cloudPublish: true }), lease)).toMatchObject({ code: "CAPABILITY_DENIED" });
    expect(await new AuthorizationPolicy(profile).authorize({ ...plan("project.open"), actionId: "project.not-real" }, lease)).toMatchObject({ code: "UNKNOWN_ACTION" });
  });

  it("requires filesystem paths and all constrained lease measurements", async () => {
    const policy = new AuthorizationPolicy(profile);
    expect(await policy.authorize(plan("project.open", { paths: [] }), lease)).toMatchObject({ code: "PATH_REQUIRED" });
    expect(await policy.authorize(plan("project.open"), { ...lease, hostVersion: undefined })).toMatchObject({ code: "HOST_VERSION_REQUIRED" });
    expect(await policy.authorize(plan("project.open"), { leaseId: "l", hostVersion: "26.3.0", elapsedRuntimeMinutes: 1 })).toMatchObject({ code: "OPERATION_INDEX_REQUIRED" });
    expect(await policy.authorize(plan("project.open"), { leaseId: "l", hostVersion: "26.3.0", operationIndex: 1 })).toMatchObject({ code: "RUNTIME_REQUIRED" });
  });

  it("rejects an existing symlink or junction escape when the platform permits creating one", async () => {
    const link = join(approvedRoot, "escape-link");
    try { symlinkSync(outsideRoot, link, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    const decision = await new AuthorizationPolicy(profile).authorize(plan("project.open", { paths: [join(link, "payload.prproj")] }), lease);
    expect(decision).toMatchObject({ code: "PATH_UNSAFE" });
  });
});
