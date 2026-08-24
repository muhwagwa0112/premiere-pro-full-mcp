import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { BridgeRequest, BridgeResponse, DispatchState, RouteBinding } from "../contracts.js";
import { effectiveBridgeRequestDigest, sha256Canonical, type ExecutionPlan } from "../security/execution-plan.js";

export class CheckpointError extends Error {
  constructor(readonly code: string, message: string, readonly dispatchState: DispatchState | null = null) { super(message); }
}

export interface CheckpointDispatch {
  execute(request: BridgeRequest): Promise<BridgeResponse>;
}

export interface CheckpointOptions {
  dispatch: CheckpointDispatch;
  plan: ExecutionPlan;
  approvedRoots: readonly string[];
  retention: number;
  now?: () => Date;
}

export interface CheckpointResult {
  projectPath: string;
  checkpointPath: string;
  bytes: number;
  sha256: string;
}

export interface CheckpointEvidenceBinding {
  operationId: string;
  bytes: number;
  sha256: string;
  projectPathDigest: string;
  checkpointPathDigest: string;
}

/** Binds a verified checkpoint copy to the exact operation that produced it. */
export function checkpointEvidenceBindingDigest(binding: CheckpointEvidenceBinding): `sha256:${string}` {
  return sha256Canonical({ schemaVersion: 1, ...binding }) as `sha256:${string}`;
}

function routeBinding(plan: ExecutionPlan): RouteBinding {
  return { backend: plan.backend, hostVersion: plan.hostVersion, hostSessionId: plan.hostSessionId, capabilityFingerprint: plan.capabilityFingerprint };
}

function within(path: string, root: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.startsWith("../") && !value.startsWith("..\\"));
}

async function canonicalExisting(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new CheckpointError("CHECKPOINT_PROJECT_PATH_INVALID", "Checkpoint project path must be absolute");
  try { return await realpath(path); }
  catch { throw new CheckpointError("CHECKPOINT_PROJECT_PATH_UNAVAILABLE", "The saved active project path is unavailable for checkpointing"); }
}

async function rejectReparsePath(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsedRoot = parse(absolute).root;
  const pieces = relative(parsedRoot, absolute).split(sep).filter(Boolean);
  let cursor = parsedRoot;
  for (const piece of pieces) {
    cursor = resolve(cursor, piece);
    if ((await lstat(cursor)).isSymbolicLink()) throw new CheckpointError("CHECKPOINT_PATH_UNSAFE", "Checkpoint path crosses a symbolic link or reparse point");
  }
}

async function verifyCopy(source: string, destination: string): Promise<{ bytes: number; sha256: string }> {
  const [sourceStat, destinationStat] = await Promise.all([stat(source), stat(destination)]);
  if (!sourceStat.isFile() || !destinationStat.isFile() || sourceStat.size <= 0 || sourceStat.size !== destinationStat.size) throw new CheckpointError("CHECKPOINT_COPY_NOT_VERIFIED", "Checkpoint copy size did not match the saved active project");
  const hash = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  const [sourceHash, checkpointHash] = await Promise.all([hash(source), hash(destination)]);
  if (sourceHash !== checkpointHash) throw new CheckpointError("CHECKPOINT_COPY_NOT_VERIFIED", "Checkpoint copy hash did not match the saved active project");
  return { bytes: sourceStat.size, sha256: `sha256:${checkpointHash}` };
}

async function enforceRetention(directory: string, retention: number): Promise<void> {
  if (!Number.isInteger(retention) || retention < 1) throw new CheckpointError("CHECKPOINT_RETENTION_INVALID", "Checkpoint retention must be a positive integer");
  const entries = await readdir(directory, { withFileTypes: true });
  const checkpoints = await Promise.all(entries.filter((entry) => entry.isFile() && /^ppmcp-checkpoint-.+\.prproj$/u.test(entry.name)).map(async (entry) => ({ path: resolve(directory, entry.name), mtimeMs: (await stat(resolve(directory, entry.name))).mtimeMs })));
  checkpoints.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  for (const entry of checkpoints.slice(retention)) {
    await rejectReparsePath(entry.path);
    if (!within(await realpath(entry.path), directory)) throw new CheckpointError("CHECKPOINT_PATH_UNSAFE", "Checkpoint retention target escaped its canonical directory");
    await rm(entry.path);
  }
}

/**
 * Saves the selected Premiere route and creates a verified sibling checkpoint.
 * Throwing from this function is intentionally fail-closed: callers must not
 * dispatch the protected mutation after a failed or unknown checkpoint route.
 */
export async function createCheckpoint(options: CheckpointOptions): Promise<CheckpointResult> {
  const { plan } = options;
  const binding = routeBinding(plan);
  const dispatchPhase = async (phase: "inspect" | "save", expected?: { projectPath: string; projectIdentity?: string }): Promise<BridgeResponse> => {
    const args = {
      checkpoint: {
        phase, routeBinding: binding, planHash: plan.planHash,
        ...(expected ? { expectedProjectPath: expected.projectPath, ...(expected.projectIdentity ? { expectedProjectIdentity: expected.projectIdentity } : {}) } : {}),
      },
    };
    return options.dispatch.execute({
      protocolVersion: 1,
      requestId: randomUUID(),
      operation: "project.checkpoint",
      args,
      routeBinding: binding,
      planHash: plan.planHash,
      effectiveRequestDigest: effectiveBridgeRequestDigest("project.checkpoint", args),
    });
  };
  const requireCompleted = (response: BridgeResponse, phase: "inspect" | "save"): Record<string, unknown> => {
    if (response.dispatchState === "unknown" || response.dispatchState === "accepted") throw new CheckpointError("CHECKPOINT_OUTCOME_UNKNOWN", response.error?.message ?? `Checkpoint ${phase} outcome is unknown`, response.dispatchState);
    if (response.dispatchState === "not_dispatched") throw new CheckpointError("CHECKPOINT_NOT_DISPATCHED", response.error?.message ?? `Checkpoint ${phase} did not dispatch`, response.dispatchState);
    if (!response.ok) throw new CheckpointError("CHECKPOINT_FAILED", response.error?.message ?? `Checkpoint ${phase} did not complete`, response.dispatchState);
    return response.result && typeof response.result === "object" ? response.result as Record<string, unknown> : {};
  };

  // Discover and authorize the active project identity before invoking save.
  const inspected = requireCompleted(await dispatchPhase("inspect"), "inspect");
  if (typeof inspected.projectPath !== "string" || inspected.projectPath.length === 0) throw new CheckpointError("CHECKPOINT_PROJECT_PATH_UNAVAILABLE", "The checkpoint inspection did not return the active project path");
  const inspectedIdentity = typeof inspected.projectIdentity === "string" && inspected.projectIdentity.length > 0 ? inspected.projectIdentity : undefined;
  const projectPath = await canonicalExisting(inspected.projectPath);
  const roots = await Promise.all(options.approvedRoots.map(canonicalExisting));
  const approvedRoot = roots.find((root) => within(projectPath, root));
  if (!approvedRoot) throw new CheckpointError("CHECKPOINT_PATH_UNAPPROVED", "The active project is outside approved roots");
  await rejectReparsePath(projectPath);
  const directory = resolve(dirname(projectPath), ".premiere-mcp-checkpoints");
  await mkdir(directory, { recursive: true });
  await rejectReparsePath(directory);
  const canonicalDirectory = await realpath(directory);
  if (!within(canonicalDirectory, approvedRoot)) throw new CheckpointError("CHECKPOINT_PATH_UNSAFE", "Checkpoint directory escaped the approved project root");

  const saved = requireCompleted(await dispatchPhase("save", { projectPath: inspected.projectPath, ...(inspectedIdentity ? { projectIdentity: inspectedIdentity } : {}) }), "save");
  if (saved.saved !== true || typeof saved.projectPath !== "string" || saved.projectPath.length === 0) throw new CheckpointError("CHECKPOINT_PROJECT_PATH_UNAVAILABLE", "The checkpoint route did not confirm save and active project path");
  const savedProjectPath = await canonicalExisting(saved.projectPath);
  if (savedProjectPath !== projectPath) throw new CheckpointError("CHECKPOINT_PROJECT_PATH_DRIFT", "The active project path changed between checkpoint inspection and save");
  const clock = options.now ?? (() => new Date());
  const stamp = clock().toISOString().replace(/[:.]/g, "-");
  const extension = extname(projectPath) || ".prproj";
  const checkpointPath = resolve(canonicalDirectory, `ppmcp-checkpoint-${stamp}-${plan.planHash.slice(-12)}-${basename(projectPath, extension)}${extension}`);
  await copyFile(projectPath, checkpointPath, constants.COPYFILE_EXCL);
  const verified = await verifyCopy(projectPath, checkpointPath);
  if (!within(await realpath(checkpointPath), canonicalDirectory)) throw new CheckpointError("CHECKPOINT_PATH_UNSAFE", "Checkpoint copy escaped its canonical directory");
  await enforceRetention(canonicalDirectory, options.retention);
  return { projectPath, checkpointPath, ...verified };
}

export async function dispatchAfterCheckpoint<T>(options: CheckpointOptions, mutation: () => Promise<T>): Promise<{ checkpoint: CheckpointResult; mutation: T }> {
  const checkpoint = await createCheckpoint(options);
  return { checkpoint, mutation: await mutation() };
}
