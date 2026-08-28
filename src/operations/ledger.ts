import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OperationLedgerEntry, PayloadMetadata, UnknownOperationSummary } from "./types.js";

export const OPERATION_LEDGER_FILE_NAME = "operation-ledger-v1.jsonl";

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): unknown => {
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) throw new TypeError("Cannot hash cyclic operation input");
    seen.add(item);
    if (Array.isArray(item)) return item.map(visit);
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, visit(record[key])]));
  };
  return JSON.stringify(visit(value));
}

export function payloadMetadata(value: unknown): PayloadMetadata {
  const bytes = Buffer.from(typeof value === "string" ? value : stableJson(value), "utf8");
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

export function hashTarget(targetHint: string, kind = "unspecified"): { kind: string; sha256: string; label?: string } {
  const normalized = String(targetHint).slice(0, 512);
  return {
    kind,
    sha256: createHash("sha256").update(normalized, "utf8").digest("hex"),
    ...(kind === "sequence" ? { label: normalized } : {}),
  };
}

const ALLOWED_KEYS = new Set([
  "schemaVersion", "operationId", "recordedAt", "toolName", "backend", "mode", "status", "target", "args", "script",
  "preSnapshot", "postSnapshot", "hostSession", "saveAt", "errorCode",
]);

function validateEntry(value: unknown): asserts value is OperationLedgerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid operation ledger entry");
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) if (!ALLOWED_KEYS.has(key)) throw new Error(`Forbidden operation ledger field '${key}'`);
  if (rec.schemaVersion !== 1 || typeof rec.operationId !== "string" || typeof rec.recordedAt !== "string" || typeof rec.toolName !== "string") {
    throw new Error("Invalid operation ledger entry identity");
  }
  if (!new Set(["cep", "uxp", "local"]).has(String(rec.backend)) || !new Set(["read", "mutate", "local"]).has(String(rec.mode))) {
    throw new Error("Invalid operation ledger routing fields");
  }
  if (!new Set(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN", "ACKNOWLEDGED"]).has(String(rec.status))) {
    throw new Error("Invalid operation ledger status");
  }
}

export class OperationLedger {
  readonly path: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(stateDir: string, fileName = OPERATION_LEDGER_FILE_NAME) {
    if (!stateDir) throw new Error("A daemon state directory is required");
    this.path = join(stateDir, fileName);
  }

  append(entry: OperationLedgerEntry): Promise<void> {
    validateEntry(entry);
    const line = `${JSON.stringify(entry)}\n`;
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.path), { recursive: true });
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    const next = this.#tail.then(write, write);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async readEntries(): Promise<OperationLedgerEntry[]> {
    await this.#tail;
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const terminated = raw.endsWith("\n");
    const lines = raw.split("\n");
    if (terminated) lines.pop();
    const entries: OperationLedgerEntry[] = [];
    let truncateAt: number | undefined;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line) throw new Error(`Invalid blank operation ledger line ${index + 1}`);
      try {
        const parsed = JSON.parse(line) as unknown;
        validateEntry(parsed);
        entries.push(parsed);
      } catch (error) {
        const isTruncatedFinal = !terminated && index === lines.length - 1;
        if (!isTruncatedFinal) throw new Error(`Corrupt operation ledger line ${index + 1}`, { cause: error });
        truncateAt = Buffer.byteLength(raw.slice(0, raw.lastIndexOf("\n") + 1), "utf8");
      }
    }
    if (truncateAt !== undefined) {
      const handle = await open(this.path, "r+");
      try { await handle.truncate(truncateAt); await handle.sync(); } finally { await handle.close(); }
    }
    return entries;
  }

  async unresolvedUnknown(): Promise<UnknownOperationSummary[]> {
    const latest = new Map<string, OperationLedgerEntry>();
    for (const entry of await this.readEntries()) latest.set(entry.operationId, entry);
    return [...latest.values()].filter((entry) => entry.status === "UNKNOWN" && entry.mode === "mutate").map((entry) => ({
      operationId: entry.operationId, toolName: entry.toolName, backend: entry.backend, recordedAt: entry.recordedAt,
      ...(entry.target ? { target: entry.target } : {}),
      ...(entry.preSnapshot ? { preFingerprint: entry.preSnapshot.fingerprint } : {}),
      ...(entry.preSnapshot?.projectionVersion !== undefined ? { preProjectionVersion: entry.preSnapshot.projectionVersion } : {}),
      ...(entry.preSnapshot?.resolvedSequenceId ? { resolvedSequenceId: entry.preSnapshot.resolvedSequenceId } : {}),
      ...(entry.preSnapshot?.resolvedSequenceName ? { resolvedSequenceName: entry.preSnapshot.resolvedSequenceName } : {}),
      ...(entry.hostSession ? { hostSession: entry.hostSession } : {}),
    }));
  }

  async operationIds(): Promise<Set<string>> {
    return new Set((await this.readEntries()).map((entry) => entry.operationId));
  }
}
