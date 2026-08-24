import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const apiFingerprint = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/);

export const fixtureEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  evidenceId: z.uuid(),
  featureId: z.string().min(3).max(128),
  backend: z.enum(["local", "uxp", "cep", "qe", "ui"]),
  hostVersion: z.string().min(1).max(64),
  hostBuild: z.string().min(1).max(128),
  apiFingerprint,
  fixtureDigest: digest,
  planHash: digest,
  beforeStateDigest: digest.nullable(),
  afterStateDigest: digest.nullable(),
  restoredStateDigest: digest.nullable(),
  outcome: z.enum(["verified", "failed", "outcome_unknown", "not_run"]),
  rollbackOutcome: z.enum(["verified", "failed", "not_applicable", "not_run"]),
  timestamp: z.iso.datetime(),
}).strict();

export type FixtureEvidence = z.infer<typeof fixtureEvidenceSchema>;

export function createFixtureEvidence(input: Omit<FixtureEvidence, "schemaVersion" | "evidenceId" | "timestamp"> & { evidenceId?: string; timestamp?: string }): FixtureEvidence {
  return fixtureEvidenceSchema.parse({
    schemaVersion: 1,
    evidenceId: input.evidenceId ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    ...input,
  });
}

export async function writeFixtureEvidence(path: string, evidenceInput: unknown): Promise<void> {
  const evidence = fixtureEvidenceSchema.parse(evidenceInput);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}
