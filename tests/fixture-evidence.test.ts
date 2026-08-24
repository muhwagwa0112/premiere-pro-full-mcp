import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createFixtureEvidence, writeFixtureEvidence } from "../src/evidence/record.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;

describe("fixture evidence", () => {
  it("requires host build/API fingerprint and persists no project paths", async () => {
    const evidence = createFixtureEvidence({
      featureId: "project.save", backend: "uxp", hostVersion: "26.3.2", hostBuild: "26.3.2.4",
      apiFingerprint: "a".repeat(64), fixtureDigest: hash("b"), planHash: hash("c"), beforeStateDigest: hash("d"),
      afterStateDigest: hash("e"), restoredStateDigest: hash("d"), outcome: "verified", rollbackOutcome: "verified",
      evidenceId: "00112233-4455-6677-8899-aabbccddeeff", timestamp: "2026-08-24T00:00:00.000Z",
    });
    const path = join(tmpdir(), `ppmcp-evidence-${process.pid}-${Date.now()}.json`);
    await writeFixtureEvidence(path, evidence);
    const saved = await readFile(path, "utf8");
    expect(saved).toContain('"hostBuild": "26.3.2.4"');
    expect(saved).toContain('"apiFingerprint"');
    expect(saved).not.toMatch(/[A-Z]:\\|\.prproj|fixture-only/i);
  });

  it("rejects incomplete live evidence", () => {
    expect(() => createFixtureEvidence({
      featureId: "project.save", backend: "uxp", hostVersion: "26.3.2", hostBuild: "",
      apiFingerprint: hash("a"), fixtureDigest: hash("b"), planHash: hash("c"), beforeStateDigest: null,
      afterStateDigest: null, restoredStateDigest: null, outcome: "verified", rollbackOutcome: "verified",
    })).toThrow();
  });
});
