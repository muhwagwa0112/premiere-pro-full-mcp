import { lstat, realpath } from "node:fs/promises";
import { posix, win32, type PlatformPath } from "node:path";
import { z } from "zod";
import { getAction } from "../catalog.js";
import { riskLevels, type TrustProfile } from "./trust-profile.js";
import { parseTrustProfile } from "./trust-profile.js";

const authorizationPlanSchema = z.object({
  actionId: z.string().min(1).max(256), risk: z.enum(riskLevels),
  authority: z.enum(["inspect", "edit", "filesystem", "cloud", "experimental"]),
  paths: z.array(z.string().min(1).max(32_767)).max(128),
  mutation: z.boolean(), nonUndoable: z.boolean(), overwrite: z.boolean(), delete: z.boolean(),
  thirdPartyPluginUi: z.boolean(), cloudPublish: z.boolean(), cloudShare: z.boolean(), purchase: z.boolean(),
}).strict();

const authorizationLeaseSchema = z.object({
  leaseId: z.string().min(1).max(128), hostVersion: z.string().min(1).max(64).optional(),
  operationIndex: z.number().int().nonnegative().optional(), mutationIndex: z.number().int().nonnegative().optional(), elapsedRuntimeMinutes: z.number().nonnegative().optional(),
}).strict();

export type AuthorizationPlan = z.infer<typeof authorizationPlanSchema>;
export type AuthorizationLease = z.infer<typeof authorizationLeaseSchema>;
export type AuthorizationDecision =
  | { outcome: "allow"; profileId: string; leaseId: string }
  | { outcome: "allow_with_checkpoint"; profileId: string; leaseId: string }
  | { outcome: "interactive_required"; reason: string }
  | { outcome: "deny"; code: string; reason: string };

export class AuthorizationPolicy {
  readonly #profile: TrustProfile;
  constructor(profile: TrustProfile) { this.#profile = parseTrustProfile(profile); }

  async authorize(untrustedPlan: unknown, untrustedLease: unknown): Promise<AuthorizationDecision> {
    const parsedPlan = authorizationPlanSchema.safeParse(untrustedPlan);
    if (!parsedPlan.success) return deny("INVALID_PLAN", "The authorization plan is incomplete or malformed");
    const parsedLease = authorizationLeaseSchema.safeParse(untrustedLease);
    if (!parsedLease.success) return deny("INVALID_LEASE", "The process lease is incomplete or malformed");
    const plan = parsedPlan.data;
    const lease = parsedLease.data;
    let trustedAction;
    try { trustedAction = getAction(plan.actionId); }
    catch { return deny("UNKNOWN_ACTION", "The action is absent from the trusted catalog"); }
    const expectedNonUndoableMutation = trustedAction.mutatesProject && !trustedAction.undoable;
    if (plan.risk !== trustedAction.risk || plan.authority !== trustedAction.authority ||
        plan.mutation !== trustedAction.mutatesProject || plan.nonUndoable !== expectedNonUndoableMutation) {
      return deny("PLAN_CATALOG_MISMATCH", "Plan security metadata does not match the trusted action catalog");
    }
    if (plan.authority === "filesystem" && plan.paths.length === 0) return deny("PATH_REQUIRED", "Filesystem actions require at least one explicit path");
    if (plan.authority !== "filesystem" && plan.paths.length > 0) return deny("UNEXPECTED_PATH", "Only filesystem actions may carry filesystem paths");
    if (this.#profile.mode === "interactive") return { outcome: "interactive_required", reason: "The interactive profile requires the existing one-shot confirmation flow" };
    if (!matchesAny(plan.actionId, this.#profile.actionAllow) || matchesAny(plan.actionId, this.#profile.actionDeny)) return deny("ACTION_DENIED", `Action ${plan.actionId} is not allowed by the trust profile`);
    if (riskLevels.indexOf(plan.risk) > riskLevels.indexOf(this.#profile.riskCeiling)) return deny("RISK_CEILING_EXCEEDED", `Risk ${plan.risk} exceeds profile ceiling ${this.#profile.riskCeiling}`);
    if (this.#profile.premiereVersions) {
      if (!lease.hostVersion) return deny("HOST_VERSION_REQUIRED", "The constrained profile requires a host version");
      if (!this.#profile.premiereVersions.some((pattern) => versionMatches(lease.hostVersion!, pattern))) return deny("HOST_VERSION_DENIED", "The Premiere host version is outside the profile range");
    }
    if (this.#profile.limits?.maxOperations !== undefined) {
      if (lease.operationIndex === undefined) return deny("OPERATION_INDEX_REQUIRED", "The constrained profile requires an operation index");
      if (lease.operationIndex >= this.#profile.limits.maxOperations) return deny("OPERATION_LIMIT_EXCEEDED", "The profile operation limit has been reached");
    }
    if (this.#profile.limits?.maxRuntimeMinutes !== undefined) {
      if (lease.elapsedRuntimeMinutes === undefined) return deny("RUNTIME_REQUIRED", "The constrained profile requires elapsed runtime");
      if (lease.elapsedRuntimeMinutes > this.#profile.limits.maxRuntimeMinutes) return deny("RUNTIME_LIMIT_EXCEEDED", "The profile runtime limit has been reached");
    }
    if (plan.mutation && this.#profile.checkpoint.beforeFirstMutation && lease.mutationIndex === undefined) return deny("MUTATION_INDEX_REQUIRED", "The checkpoint policy requires a mutation-specific lease index");
    const capability = deniedCapability(plan, this.#profile);
    if (capability) return deny("CAPABILITY_DENIED", `${capability} is not allowed by the trust profile`);
    try {
      if (!(await allPathsWithinApprovedRoots(plan.paths, this.#profile.approvedRoots))) return deny("PATH_DENIED", "A requested path is outside the approved roots");
    } catch { return deny("PATH_UNSAFE", "A requested path cannot be safely canonicalized or crosses a reparse point"); }
    const operationIndex = lease.operationIndex ?? 0;
    const checkpoint = (plan.mutation && this.#profile.checkpoint.beforeFirstMutation && lease.mutationIndex === 0) ||
      (plan.nonUndoable && this.#profile.checkpoint.beforeNonUndoable) ||
      (operationIndex > 0 && operationIndex % this.#profile.checkpoint.intervalOperations === 0);
    return checkpoint ? { outcome: "allow_with_checkpoint", profileId: this.#profile.profileId, leaseId: lease.leaseId }
      : { outcome: "allow", profileId: this.#profile.profileId, leaseId: lease.leaseId };
  }
}

function deny(code: string, reason: string): AuthorizationDecision { return { outcome: "deny", code, reason }; }
function matchesAny(actionId: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`, "u").test(actionId));
}
function versionMatches(version: string, pattern: string): boolean {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[0-9A-Za-z_-]+")}$`, "u").test(version);
}
function deniedCapability(plan: AuthorizationPlan, profile: TrustProfile): string | undefined {
  const names = ["overwrite", "delete", "thirdPartyPluginUi", "cloudPublish", "cloudShare", "purchase"] as const;
  return names.find((name) => plan[name] && !profile.capabilities[name]);
}

interface CanonicalPath { value: string; pathApi: PlatformPath }
async function allPathsWithinApprovedRoots(paths: readonly string[], roots: readonly string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  const canonicalRoots = await Promise.all(roots.map(async (root) => canonicalizeWithoutReparse(root, false)));
  for (const path of paths) {
    const target = await canonicalizeWithoutReparse(path);
    if (!canonicalRoots.some((root) => isWithin(target, root))) return false;
  }
  return true;
}
async function canonicalizeWithoutReparse(path: string, allowMissingChild = true): Promise<CanonicalPath> {
  const pathApi = win32.isAbsolute(path) ? win32 : posix;
  if (!pathApi.isAbsolute(path)) throw new Error("Path must be absolute");
  const suffix: string[] = [];
  let cursor = pathApi.resolve(path);
  while (true) {
    try { await lstat(cursor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!allowMissingChild) throw error;
      const parent = pathApi.dirname(cursor);
      if (parent === cursor) throw new Error("No existing parent");
      suffix.unshift(pathApi.basename(cursor)); cursor = parent;
    }
  }
  await assertNoReparseComponents(cursor, pathApi);
  return { value: pathApi.resolve(await realpath(cursor), ...suffix), pathApi };
}
async function assertNoReparseComponents(path: string, pathApi: PlatformPath): Promise<void> {
  const parsed = pathApi.parse(path);
  const relativeParts = path.slice(parsed.root.length).split(pathApi.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const part of relativeParts) {
    cursor = pathApi.join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Reparse point rejected");
  }
}
function isWithin(target: CanonicalPath, root: CanonicalPath): boolean {
  if (target.pathApi !== root.pathApi) return false;
  const result = target.pathApi.relative(root.value, target.value);
  return result === "" || (result !== ".." && !result.startsWith(`..${target.pathApi.sep}`) && !target.pathApi.isAbsolute(result));
}
