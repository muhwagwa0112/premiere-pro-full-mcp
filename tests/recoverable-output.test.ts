import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecoverableOutput, RecoverableOutputError } from "../src/workflows/recoverable-output.js";

const operationId = "11111111-1111-4111-8111-111111111111";

describe("recoverable export output", () => {
  it("backs up, verifies a temporary output, and atomically replaces the final file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-output-"));
    const finalPath = join(directory, "render.mov");
    await writeFile(finalPath, "old-output");
    const output = new RecoverableOutput(finalPath, operationId, { stableDelayMs: 0 });

    const temporaryPath = await output.begin();
    await expect(stat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(temporaryPath, "new-output");
    const verified = await output.complete();

    expect(await readFile(finalPath, "utf8")).toBe("new-output");
    expect(verified).toMatchObject({ bytes: 10, sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    await expect(stat(output.paths.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(output.journalPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("commits a new output without inventing a restorable original", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-output-new-"));
    const finalPath = join(directory, "render.mov");
    const output = new RecoverableOutput(finalPath, operationId, { stableDelayMs: 0 });

    const temporaryPath = await output.begin();
    await writeFile(temporaryPath, "new-only-output");
    await output.complete();

    expect(await readFile(finalPath, "utf8")).toBe("new-only-output");
    await expect(stat(output.journalPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the original after a known pre-completion failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-output-"));
    const finalPath = join(directory, "render.mov");
    await writeFile(finalPath, "original");
    const output = new RecoverableOutput(finalPath, operationId, { stableDelayMs: 0 });
    const temporaryPath = await output.begin();
    await writeFile(temporaryPath, "partial");

    await output.restoreKnownFailure();

    expect(await readFile(finalPath, "utf8")).toBe("original");
    await expect(stat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves recovery artifacts and emits privacy-safe evidence for an unknown outcome", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-output-"));
    const finalPath = join(directory, "render.mov");
    await writeFile(finalPath, "original");
    const output = new RecoverableOutput(finalPath, operationId, { stableDelayMs: 0 });
    const temporaryPath = await output.begin();
    await writeFile(temporaryPath, "possibly-complete");

    const evidence = output.reconciliationEvidence();

    expect(evidence).toMatchObject({ state: "reconciliation_required", originalWasBackedUp: true });
    expect(JSON.stringify(evidence)).not.toContain(directory);
    expect(await readFile(output.paths.backupPath, "utf8")).toBe("original");
    expect(await readFile(temporaryPath, "utf8")).toBe("possibly-complete");
  });

  it("fails closed when stale artifacts from the same operation exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-output-"));
    const output = new RecoverableOutput(join(directory, "render.mov"), operationId);
    await writeFile(output.paths.temporaryPath, "stale");
    await expect(output.begin()).rejects.toThrow(/reconciliation is required/);
  });

  it("durably journals the original snapshot before rename and quarantines every operationId for the same canonical output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-output-journal-"));
    const finalPath = join(directory, "render.mov");
    await writeFile(finalPath, "original");
    const first = new RecoverableOutput(finalPath, operationId, { stableDelayMs: 0 });

    await first.begin();

    const header = JSON.parse((await readFile(first.journalPath!, "utf8")).split("\n")[0]!) as Record<string, unknown>;
    expect(header).toMatchObject({ schemaVersion: 1, type: "recoverable-output", operationId, phase: "prepared", original: { bytes: 8, sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) } });
    await expect(RecoverableOutput.assertNoUnfinishedTransaction(finalPath)).rejects.toMatchObject({ code: "OUTPUT_RECOVERY_QUARANTINED" });
    const second = new RecoverableOutput(finalPath, "22222222-2222-4222-8222-222222222222");
    await expect(second.begin()).rejects.toMatchObject({ code: "OUTPUT_RECOVERY_QUARANTINED" });
    await first.restoreKnownFailure();
    expect(await readFile(finalPath, "utf8")).toBe("original");
  });

  it("keeps the output quarantined when the required backup disappears", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-output-missing-backup-"));
    const finalPath = join(directory, "render.mov");
    await writeFile(finalPath, "original");
    const output = new RecoverableOutput(finalPath, operationId, { stableDelayMs: 0 });
    await output.begin();
    await rm(output.paths.backupPath);

    const failure = await output.restoreKnownFailure().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RecoverableOutputError);
    expect(failure).toMatchObject({ code: "OUTPUT_RECOVERY_RESTORE_FAILED", evidence: { state: "reconciliation_required", originalWasBackedUp: true } });
    await expect(stat(output.journalPath!)).resolves.toBeDefined();
    await expect(stat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to restore a backup whose content no longer matches the journaled original snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-output-tampered-backup-"));
    const finalPath = join(directory, "render.mov");
    await writeFile(finalPath, "original");
    const output = new RecoverableOutput(finalPath, operationId, { stableDelayMs: 0 });
    await output.begin();
    await writeFile(output.paths.backupPath, "tampered");

    await expect(output.restoreKnownFailure()).rejects.toMatchObject({ code: "OUTPUT_RECOVERY_RESTORE_FAILED" });
    await expect(stat(output.journalPath!)).resolves.toBeDefined();
  });

  it("rejects a reparse substitution immediately before destructive publish or cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-output-reparse-"));
    const finalPath = join(directory, "render.mov");
    const outsidePath = join(directory, "outside.mov");
    await writeFile(finalPath, "original");
    await writeFile(outsidePath, "outside");
    const output = new RecoverableOutput(finalPath, operationId, { stableDelayMs: 0 });
    const temporaryPath = await output.begin();
    try { await symlink(outsidePath, temporaryPath, "file"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }

    await expect(output.complete()).rejects.toMatchObject({ code: "OUTPUT_RECOVERY_RESTORE_FAILED", evidence: { state: "reconciliation_required" } });
    expect(await readFile(outsidePath, "utf8")).toBe("outside");
    await expect(stat(output.journalPath!)).resolves.toBeDefined();
  });
});
