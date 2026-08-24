import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { sha256Canonical } from "../security/execution-plan.js";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/);

export const liveFixtureManifestSchema = z.object({
  schemaVersion: z.literal(1),
  fixtureId: slugSchema,
  description: z.string().min(1).max(512),
  project: z.discriminatedUnion("strategy", [
    z.object({ strategy: z.literal("generated_empty"), relativeName: z.string().regex(/^[A-Za-z0-9._-]+\.prproj$/i) }).strict(),
    z.object({ strategy: z.literal("repository_seed"), sourceProject: z.string().regex(/^[A-Za-z0-9._/-]+\.prproj$/i) }).strict(),
  ]),
  mutation: z.object({
    actionId: z.literal("project.save"),
    args: z.object({}).strict(),
  }).strict(),
  verification: z.object({
    beforeActionId: z.literal("project.inspect"),
    afterActionId: z.literal("project.inspect"),
    requireVerifiedHostResult: z.literal(true),
  }).strict(),
  restore: z.object({
    strategy: z.literal("pristine_copy_reopen"),
    verifySourceDigest: z.literal(true),
    verifyProjectStateDigest: z.literal(true),
  }).strict(),
}).strict();

export type LiveFixtureManifest = z.infer<typeof liveFixtureManifestSchema>;

export interface FixturePlan {
  schemaVersion: 1;
  mode: "plan_only" | "live";
  runId: string;
  fixtureId: string;
  fixtureDigest: string;
  planHash: string;
  safety: {
    fixtureOriginRestricted: true;
    workspaceMustBeOsTemporary: true;
    abortWhenProjectOpen: true;
    liveRequiresExplicitFlag: true;
    rawPathsInEvidence: false;
  };
  phases: readonly ["preflight", "prepare_copy", "capture_before", "mutate_once", "verify_after", "close_working", "restore_pristine_copy", "verify_restore", "close_restore", "cleanup_workspace"];
  mutation: { actionId: string; argsDigest: string };
  restore: LiveFixtureManifest["restore"];
}

export function buildFixturePlan(manifestInput: unknown, input: { mode?: "plan_only" | "live"; runId?: string; fixtureDigest?: string } = {}): FixturePlan {
  const manifest = liveFixtureManifestSchema.parse(manifestInput);
  const mode = input.mode ?? "plan_only";
  const runId = input.runId ?? randomUUID();
  const fixtureDigest = input.fixtureDigest ?? sha256Canonical(manifest);
  digestSchema.parse(fixtureDigest);
  const material = {
    schemaVersion: 1 as const,
    mode,
    runId,
    fixtureId: manifest.fixtureId,
    fixtureDigest,
    safety: {
      fixtureOriginRestricted: true as const,
      workspaceMustBeOsTemporary: true as const,
      abortWhenProjectOpen: true as const,
      liveRequiresExplicitFlag: true as const,
      rawPathsInEvidence: false as const,
    },
    phases: ["preflight", "prepare_copy", "capture_before", "mutate_once", "verify_after", "close_working", "restore_pristine_copy", "verify_restore", "close_restore", "cleanup_workspace"] as const,
    mutation: { actionId: manifest.mutation.actionId, argsDigest: sha256Canonical(manifest.mutation.args) },
    restore: manifest.restore,
  };
  return { ...material, planHash: sha256Canonical(material) };
}

export function verifyFixturePlan(plan: FixturePlan): boolean {
  const { planHash, ...material } = plan;
  return digestSchema.safeParse(planHash).success && planHash === sha256Canonical(material);
}

export interface PreparedFixture {
  runId: string;
  workspace: string;
  workingProject: string;
  restoreProject: string;
  fixtureDigest: string;
}

export interface UnsealedGeneratedFixture {
  runId: string;
  workspace: string;
  workingProject: string;
  restoreProject: string;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return `sha256:${hash.digest("hex")}`;
}

async function assertRegularNonReparseFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Fixture source must be a regular, non-link file");
  if (process.platform === "win32" && (metadata.mode & 0o170000) !== 0o100000) throw new Error("Fixture source must not be a reparse point");
}

export async function prepareDisposableFixture(input: { repositoryFixturesRoot: string; sourceProject: string; runId?: string }): Promise<PreparedFixture> {
  const fixturesRoot = await realpath(resolve(input.repositoryFixturesRoot));
  const requestedSource = resolve(fixturesRoot, input.sourceProject);
  if (!isWithin(fixturesRoot, requestedSource) || extname(requestedSource).toLowerCase() !== ".prproj") throw new Error("Fixture source must be a .prproj below the repository fixtures directory");
  await assertRegularNonReparseFile(requestedSource);
  const source = await realpath(requestedSource);
  if (!isWithin(fixturesRoot, source)) throw new Error("Fixture source resolves outside the repository fixtures directory");
  const fixtureDigest = await sha256File(source);
  const runId = input.runId ?? randomUUID();
  const temporaryBase = resolve(tmpdir());
  const workspace = await mkdtemp(join(temporaryBase, "premiere-mcp-live-fixture-"));
  if (!isWithin(temporaryBase, workspace)) throw new Error("Fixture workspace was not allocated below the OS temporary directory");
  const workingProject = join(workspace, `${runId}-working.prproj`);
  const restoreProject = join(workspace, `${runId}-restore.prproj`);
  try {
    await copyFile(source, workingProject);
    await copyFile(source, restoreProject);
    if (await sha256File(workingProject) !== fixtureDigest || await sha256File(restoreProject) !== fixtureDigest) throw new Error("Fixture copy digest verification failed");
    return { runId, workspace, workingProject, restoreProject, fixtureDigest };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

export async function allocateGeneratedFixture(input: { runId?: string; projectName: string }): Promise<UnsealedGeneratedFixture> {
  if (!/^[A-Za-z0-9._-]+\.prproj$/i.test(input.projectName)) throw new Error("Generated fixture project name must be a simple .prproj filename");
  const runId = input.runId ?? randomUUID();
  const temporaryBase = resolve(tmpdir());
  const workspace = await mkdtemp(join(temporaryBase, "premiere-mcp-live-fixture-"));
  if (!isWithin(temporaryBase, workspace)) throw new Error("Fixture workspace was not allocated below the OS temporary directory");
  return { runId, workspace, workingProject: join(workspace, `${runId}-working-${input.projectName}`), restoreProject: join(workspace, `${runId}-restore-${input.projectName}`) };
}

export async function sealGeneratedFixture(generated: UnsealedGeneratedFixture): Promise<PreparedFixture> {
  const workspace = await realpath(generated.workspace);
  if (!isWithin(resolve(tmpdir()), workspace)) throw new Error("Generated fixture is not inside OS temporary storage");
  await assertRegularNonReparseFile(generated.workingProject);
  const fixtureDigest = await sha256File(generated.workingProject);
  try {
    await copyFile(generated.workingProject, generated.restoreProject);
    if (await sha256File(generated.restoreProject) !== fixtureDigest) throw new Error("Generated fixture baseline copy verification failed");
    return { ...generated, fixtureDigest };
  } catch (error) {
    await rm(generated.restoreProject, { force: true });
    throw error;
  }
}

export async function verifyPristineRestore(prepared: PreparedFixture): Promise<{ verified: true; fixtureDigest: string; restoredBytes: number }> {
  const workspace = await realpath(prepared.workspace);
  const temporaryBase = resolve(tmpdir());
  if (!isWithin(temporaryBase, workspace)) throw new Error("Restore project is not inside an OS-temporary fixture workspace");
  const restored = await realpath(prepared.restoreProject);
  if (!isWithin(workspace, restored) || basename(restored) !== basename(prepared.restoreProject)) throw new Error("Restore project escaped its fixture workspace");
  await assertRegularNonReparseFile(restored);
  if (await sha256File(restored) !== prepared.fixtureDigest) throw new Error("Pristine restore digest does not match the source fixture");
  return { verified: true, fixtureDigest: prepared.fixtureDigest, restoredBytes: (await stat(restored)).size };
}

export async function cleanupDisposableFixture(prepared: PreparedFixture): Promise<void> {
  const temporaryBase = resolve(tmpdir());
  const workspace = resolve(prepared.workspace);
  if (!isWithin(temporaryBase, workspace) || !basename(workspace).startsWith("premiere-mcp-live-fixture-")) throw new Error("Refusing to remove a non-fixture workspace");
  await rm(workspace, { recursive: true, force: true });
}
