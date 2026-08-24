import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { allocateGeneratedFixture, buildFixturePlan, cleanupDisposableFixture, prepareDisposableFixture, sealGeneratedFixture, verifyFixturePlan, verifyPristineRestore, type PreparedFixture } from "../src/evidence/fixture-plan.js";

const manifest = {
  schemaVersion: 1,
  fixtureId: "test-project",
  description: "Repository fixture for plan tests",
  project: { strategy: "repository_seed", sourceProject: "seeds/test.prproj" },
  mutation: { actionId: "project.save", args: {} },
  verification: { beforeActionId: "project.inspect", afterActionId: "project.inspect", requireVerifiedHostResult: true },
  restore: { strategy: "pristine_copy_reopen", verifySourceDigest: true, verifyProjectStateDigest: true },
} as const;

const prepared: PreparedFixture[] = [];
const sourceRoots: string[] = [];
afterEach(async () => {
  await Promise.all(prepared.splice(0).map(cleanupDisposableFixture));
  await Promise.all(sourceRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("disposable fixture plan", () => {
  it("is plan-only by default and binds every safety and restore phase", () => {
    const plan = buildFixturePlan(manifest, { runId: "00112233-4455-6677-8899-aabbccddeeff" });
    expect(plan.mode).toBe("plan_only");
    expect(plan.safety).toEqual({ fixtureOriginRestricted: true, workspaceMustBeOsTemporary: true, abortWhenProjectOpen: true, liveRequiresExplicitFlag: true, rawPathsInEvidence: false });
    expect(plan.phases).toEqual(["preflight", "prepare_copy", "capture_before", "mutate_once", "verify_after", "close_working", "restore_pristine_copy", "verify_restore", "close_restore", "cleanup_workspace"]);
    expect(verifyFixturePlan(plan)).toBe(true);
    expect(JSON.stringify(plan)).not.toContain(".prproj");
  });

  it("copies only a repository fixture into OS temporary storage and verifies pristine restore", async () => {
    const root = join(tmpdir(), `ppmcp-fixture-root-${process.pid}-${Math.random().toString(16).slice(2)}`);
    sourceRoots.push(root);
    await mkdir(join(root, "seeds"), { recursive: true });
    await writeFile(join(root, "seeds", "test.prproj"), "fixture-only", "utf8");
    const item = await prepareDisposableFixture({ repositoryFixturesRoot: root, sourceProject: "seeds/test.prproj" });
    prepared.push(item);
    expect(await realpath(item.workspace)).not.toContain(await realpath(root));
    expect(await readFile(item.workingProject, "utf8")).toBe("fixture-only");
    await expect(verifyPristineRestore(item)).resolves.toMatchObject({ verified: true, restoredBytes: 12 });
  });

  it("rejects a source outside the declared fixture root", async () => {
    const root = join(tmpdir(), `ppmcp-fixture-root-${process.pid}-${Math.random().toString(16).slice(2)}`);
    sourceRoots.push(root);
    await mkdir(root, { recursive: true });
    await expect(prepareDisposableFixture({ repositoryFixturesRoot: root, sourceProject: "../user.prproj" })).rejects.toThrow(/below the repository fixtures/);
  });

  it("detects plan tampering and restore-copy corruption", async () => {
    const plan = buildFixturePlan(manifest);
    expect(verifyFixturePlan({ ...plan, mutation: { ...plan.mutation, actionId: "project.open" } })).toBe(false);

    const root = join(tmpdir(), `ppmcp-fixture-root-${process.pid}-${Math.random().toString(16).slice(2)}`);
    sourceRoots.push(root);
    await mkdir(join(root, "seeds"), { recursive: true });
    await writeFile(join(root, "seeds", "test.prproj"), "fixture-only", "utf8");
    const item = await prepareDisposableFixture({ repositoryFixturesRoot: root, sourceProject: "seeds/test.prproj" });
    prepared.push(item);
    await writeFile(item.restoreProject, "tampered", "utf8");
    await expect(verifyPristineRestore(item)).rejects.toThrow(/digest does not match/);
  });

  it("seals a Premiere-generated empty project as the pristine baseline", async () => {
    const generated = await allocateGeneratedFixture({ projectName: "empty.prproj" });
    await writeFile(generated.workingProject, "premiere-generated", "utf8");
    const item = await sealGeneratedFixture(generated);
    prepared.push(item);
    await expect(verifyPristineRestore(item)).resolves.toMatchObject({ verified: true, restoredBytes: 18 });
  });

  it("binds live execution to unattended trust, file readback, project close, and cleanup", async () => {
    const source = await readFile(new URL("../e2e/live-host/run-fixture.mjs", import.meta.url), "utf8");
    expect(source).toContain('PREMIERE_MCP_AUTOMATION_MODE');
    expect(source).toContain('PREMIERE_MCP_TRUST_PROFILE_ID');
    expect(source).toContain('fileEvidence(prepared.workingProject)');
    expect(source).toContain('"project.close_disposable"');
    expect(source).toContain('cleanupDisposableFixture(prepared)');
  });
});
