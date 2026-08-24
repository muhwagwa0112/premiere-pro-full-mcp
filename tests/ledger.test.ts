import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OperationLedger, type LedgerRecord } from "../src/ledger.js";

function record(overrides: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    operationId: "11111111-1111-4111-8111-111111111111", actionId: "export.sequence", backend: "uxp", risk: "R3", status: "reconciliation_required",
    timestamp: "2026-01-01T00:00:00.000Z", verificationOutcome: "committed_unverified", beforeRevision: "before", afterRevision: null,
    ...overrides,
  };
}

describe("operation ledger reconciliation persistence", () => {
  it("persists and reloads only digested reconciliation recovery evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-ledger-reconciliation-"));
    const ledger = new OperationLedger(directory);
    await ledger.record(record({ reconciliation: { phase: "output_commit", errorCode: "OUTPUT_COMMIT_UNKNOWN", recoveryEvidenceDigests: ["C:\\private\\render.tmp", "C:\\private\\render.backup"], lockDigest: "C:\\private\\render.lock" } }));

    const persisted = await readFile(join(directory, "ledger.jsonl"), "utf8");
    expect(persisted).not.toContain("C:\\private");
    expect(persisted).toContain("OUTPUT_COMMIT_UNKNOWN");
    const reloaded = await new OperationLedger(directory).get("11111111-1111-4111-8111-111111111111");
    expect(reloaded?.reconciliation).toMatchObject({ phase: "output_commit", errorCode: "OUTPUT_COMMIT_UNKNOWN", lockDigest: expect.stringMatching(/^sha256:/) });
    expect(reloaded?.reconciliation?.recoveryEvidenceDigests).toEqual([expect.stringMatching(/^sha256:/), expect.stringMatching(/^sha256:/)]);
  });

  it("migrates legacy raw recovery data and strips non-ledger fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-ledger-migration-"));
    const legacy = { ...record({ reconciliation: { phase: "checkpoint", errorCode: "checkpoint timeout at C:\\private", recoveryEvidenceDigests: ["C:\\private\\checkpoint.prproj"], lockDigest: "C:\\private\\checkpoint.lock" } }), args: { projectPath: "C:\\private\\edit.prproj" }, result: { outputPath: "C:\\private\\render.mp4" } };
    await writeFile(join(directory, "ledger.jsonl"), `${JSON.stringify(legacy)}\n`, "utf8");

    const ledger = new OperationLedger(directory);
    await expect(ledger.get(legacy.operationId)).resolves.toMatchObject({ reconciliation: { phase: "checkpoint", errorCode: "UNSAFE_ERROR_CODE", recoveryEvidenceDigests: [expect.stringMatching(/^sha256:/)] } });
    const migrated = await readFile(join(directory, "ledger.jsonl"), "utf8");
    expect(migrated).not.toContain("C:\\private");
    expect(migrated).not.toContain('"args"');
    expect(migrated).not.toContain('"result"');
  });
});
