import { mkdir, appendFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { Backend, OperationStatus, ReconciliationLedgerEvidence, Risk } from "./contracts.js";

export interface LedgerRecord {
  operationId: string;
  actionId: string;
  backend: Backend | null;
  risk: Risk;
  status: OperationStatus;
  timestamp: string;
  verificationOutcome: string;
  beforeRevision: string | null;
  afterRevision: string | null;
  reconciliation?: ReconciliationLedgerEvidence;
}

function revisionFingerprint(value: string | null): string | null {
  if (value === null) return null;
  if (/^sha256:[0-9a-f]{64}$/.test(value)) return value;
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(value: string): string {
  return /^sha256:[0-9a-f]{64}$/.test(value) ? value : `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function reconciliationEvidence(value: ReconciliationLedgerEvidence | undefined): ReconciliationLedgerEvidence | undefined {
  if (!value) return undefined;
  const phase = value.phase === "checkpoint" || value.phase === "original_dispatch" || value.phase === "output_commit" || value.phase === "local_recovery"
    ? value.phase
    : "local_recovery";
  const errorCode = /^[A-Z0-9_]{1,128}$/.test(value.errorCode) ? value.errorCode : "UNSAFE_ERROR_CODE";
  const recoveryEvidenceDigests = [...new Set((Array.isArray(value.recoveryEvidenceDigests) ? value.recoveryEvidenceDigests : []).slice(0, 64).filter((item): item is string => typeof item === "string").map(digest))].sort();
  const lockDigest = typeof value.lockDigest === "string" ? digest(value.lockDigest) : null;
  return { phase, errorCode, recoveryEvidenceDigests, lockDigest };
}

function privacySafe(record: LedgerRecord): LedgerRecord {
  const reconciliation = reconciliationEvidence(record.reconciliation);
  return {
    operationId: record.operationId,
    actionId: record.actionId,
    backend: record.backend,
    risk: record.risk,
    status: record.status,
    timestamp: record.timestamp,
    verificationOutcome: record.verificationOutcome,
    beforeRevision: revisionFingerprint(record.beforeRevision),
    afterRevision: revisionFingerprint(record.afterRevision),
    ...(reconciliation ? { reconciliation } : {}),
  };
}

function defaultLedgerDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  return join(localAppData && localAppData.length > 0 ? localAppData : join(homedir(), "AppData", "Local"), "PremiereMCP", "operations");
}

export class OperationLedger {
  readonly #directory: string;
  readonly #file: string;
  readonly #records = new Map<string, LedgerRecord>();
  readonly #orphanedUnfinished = new Set<string>();
  #ready: Promise<void>;

  constructor(directory = defaultLedgerDirectory()) {
    this.#directory = directory;
    this.#file = join(directory, "ledger.jsonl");
    this.#ready = this.initialize();
  }

  async record(entry: LedgerRecord): Promise<void> {
    await this.#ready;
    const frozen = Object.freeze(privacySafe(entry));
    await appendFile(this.#file, `${JSON.stringify(frozen)}\n`, { encoding: "utf8", mode: 0o600 });
    this.#records.set(entry.operationId, frozen);
    if (entry.status !== "planned" && entry.status !== "dispatched") this.#orphanedUnfinished.delete(entry.operationId);
  }

  async get(operationId: string): Promise<LedgerRecord | null> {
    await this.#ready;
    return this.#records.get(operationId) ?? null;
  }

  async activeReconciliations(): Promise<LedgerRecord[]> {
    await this.#ready;
    return [...this.#records.values()].filter((record) => record.status === "reconciliation_required" || this.#orphanedUnfinished.has(record.operationId));
  }

  get directory(): string {
    return this.#directory;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    try {
      const contents = await readFile(this.#file, "utf8");
      const migrated: LedgerRecord[] = [];
      let needsMigration = false;
      for (const line of contents.split(/\r?\n/)) {
        if (!line) continue;
        try {
          const record = JSON.parse(line) as LedgerRecord;
          if (record.operationId && record.actionId) {
            const safe = privacySafe(record);
            if (JSON.stringify(safe) !== JSON.stringify(record)) needsMigration = true;
            migrated.push(safe);
            this.#records.set(record.operationId, safe);
          }
        } catch {
          // A truncated final line is ignored. The ledger contains no operation arguments or results.
        }
      }
      for (const record of this.#records.values()) {
        if (record.status === "planned" || record.status === "dispatched") this.#orphanedUnfinished.add(record.operationId);
      }
      if (needsMigration) {
        const temporary = `${this.#file}.${process.pid}.migration.tmp`;
        await writeFile(temporary, migrated.map((record) => JSON.stringify(record)).join("\n") + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
        try { await rename(temporary, this.#file); }
        catch (error) { await rm(temporary, { force: true }); throw error; }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
