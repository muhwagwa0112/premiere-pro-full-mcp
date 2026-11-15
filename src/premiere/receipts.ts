import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "../automation/canonical.js";

export interface StoredReceipt { operationId: string; requestDigest: string; status: string; }
interface Tombstone extends StoredReceipt { resultRetention: "expired"; expiredAt: string; }
const TERMINAL = new Set(["SUCCEEDED", "FAILED_NO_EFFECT", "CANCELLED_NO_EFFECT"]);
const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
/** The daemon is the sole writer. Pending/unknown receipts are never evicted. */
export class RetainedReceiptStore<T extends StoredReceipt> {
  private initialization: Promise<void> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly bodies = new Map<string, { bytes: number; modified: number }>();
  constructor(readonly directory: string, private readonly maximumBodies = 256, private readonly maximumBytes = 64 * 1024 * 1024) {}
  private path(id: string): string { return join(this.directory, digest(id) + ".json"); }
  private async initialize(): Promise<void> {
    this.initialization ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      for (const name of await readdir(this.directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const file = join(this.directory, name), raw = await readFile(file, "utf8");
        const value = JSON.parse(raw) as T | Tombstone;
        if ("resultRetention" in value || !TERMINAL.has(value.status)) continue;
        this.bodies.set(value.operationId, { bytes: Buffer.byteLength(raw), modified: (await stat(file)).mtimeMs });
      }
      await this.compact();
    })();
    return this.initialization;
  }
  private async atomic(id: string, value: T | Tombstone): Promise<number> {
    const destination = this.path(id), temporary = destination + "." + randomUUID() + ".tmp";
    const raw = JSON.stringify(value), file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
    await rename(temporary, destination);
    return Buffer.byteLength(raw);
  }
  private async compact(): Promise<void> {
    let bytes = [...this.bodies.values()].reduce((sum, body) => sum + body.bytes, 0);
    for (const [id, body] of [...this.bodies].sort((a, b) => a[1].modified - b[1].modified)) {
      if (this.bodies.size <= this.maximumBodies && bytes <= this.maximumBytes) break;
      const value = JSON.parse(await readFile(this.path(id), "utf8")) as T;
      if (!TERMINAL.has(value.status)) { this.bodies.delete(id); bytes -= body.bytes; continue; }
      await this.atomic(id, { operationId: value.operationId, requestDigest: value.requestDigest, status: value.status, resultRetention: "expired", expiredAt: new Date().toISOString() });
      this.bodies.delete(id); bytes -= body.bytes;
    }
  }
  async read(id: string, expectedDigest?: string): Promise<T | null> {
    await this.initialize(); await this.tail;
    let value: T | Tombstone;
    try { value = JSON.parse(await readFile(this.path(id), "utf8")) as T | Tombstone; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (value.operationId !== id) throw coded("RECEIPT_ID_MISMATCH", "Stored receipt identity differs from its key");
    if (expectedDigest && value.requestDigest !== expectedDigest) throw coded("IDEMPOTENCY_CONFLICT", "This identity was accepted with another payload");
    if ("resultRetention" in value) throw coded("RESULT_EXPIRED", "The operation identity remains reserved; its result body has expired and cannot be replayed");
    return value;
  }
  async write(value: T): Promise<void> {
    await this.initialize();
    const save = async () => {
      let previous: StoredReceipt | Tombstone | undefined;
      try { previous = JSON.parse(await readFile(this.path(value.operationId), "utf8")) as StoredReceipt | Tombstone; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (previous && previous.requestDigest !== value.requestDigest) throw coded("IDEMPOTENCY_CONFLICT", "Cannot replace an accepted receipt with another payload");
      if (previous && "resultRetention" in previous) throw coded("RESULT_EXPIRED", "An expired operation cannot be executed again");
      const bytes = await this.atomic(value.operationId, value);
      if (TERMINAL.has(value.status)) this.bodies.set(value.operationId, { bytes, modified: Date.now() });
      else this.bodies.delete(value.operationId);
      await this.compact();
    };
    const result = this.tail.then(save, save); this.tail = result.then(() => undefined, () => undefined); return result;
  }
}
