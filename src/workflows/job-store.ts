import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JobRecord } from "./job-contracts.js";
import { brokerProtect, brokerSign, brokerUnprotect, brokerVerify } from "../security/hmac-broker.js";

export interface JobStoreProtector {
  sign(message: string): Promise<string>;
  verify(message: string, signature: string): Promise<boolean>;
  protect(message: string): Promise<string>;
  unprotect(ciphertext: string): Promise<string>;
}

interface ProtectedJobEnvelope { version: 1; payload: string; signature: string }

const defaultProtector: JobStoreProtector = {
  sign: (message) => brokerSign("approval-hmac", `job-v1\n${message}`),
  verify: (message, signature) => brokerVerify("approval-hmac", `job-v1\n${message}`, signature),
  protect: brokerProtect,
  unprotect: brokerUnprotect,
};

const MAX_RECORD_BYTES = 700 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 256 * 1024 * 1024;
const MAX_JOB_FILES = 1024;

function defaultJobDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  return join(localAppData && localAppData.length > 0 ? localAppData : join(homedir(), "AppData", "Local"), "PremiereMCP", "jobs");
}

function clone(record: JobRecord): JobRecord {
  return structuredClone(record);
}

const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class JobStore {
  readonly #directory: string;
  readonly #records = new Map<string, JobRecord>();
  readonly #updates = new Map<string, Promise<void>>();
  readonly #ready: Promise<void>;
  readonly #protector: JobStoreProtector;
  #journalUpdate: Promise<void> = Promise.resolve();

  constructor(directory = defaultJobDirectory(), protector: JobStoreProtector = defaultProtector) {
    this.#directory = directory;
    this.#protector = protector;
    this.#ready = this.initialize();
  }

  async create(record: JobRecord): Promise<void> {
    await this.#ready;
    await this.serial(record.jobId, async () => {
      if (this.#records.has(record.jobId)) throw new Error(`Job ${record.jobId} already exists`);
      await this.append(record);
      this.#records.set(record.jobId, clone(record));
    });
  }

  async get(jobId: string): Promise<JobRecord | null> {
    await this.#ready;
    return this.#records.has(jobId) ? clone(this.#records.get(jobId)!) : null;
  }

  async update(jobId: string, change: (current: JobRecord) => JobRecord | null | Promise<JobRecord | null>): Promise<JobRecord> {
    await this.#ready;
    let result: JobRecord | undefined;
    await this.serial(jobId, async () => {
      const current = this.#records.get(jobId);
      if (!current) throw new Error(`Job ${jobId} was not found`);
      const next = await change(clone(current));
      if (next === null) {
        result = clone(current);
        return;
      }
      if (next.jobId !== jobId) throw new Error("A job update cannot change jobId");
      await this.append(next);
      this.#records.set(jobId, clone(next));
      result = clone(next);
    });
    return result!;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.#directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const journalPath = join(this.#directory, entry.name);
        if ((await stat(journalPath)).size > MAX_JOURNAL_BYTES) continue;
        const contents = await readFile(journalPath, "utf8");
        let latest: JobRecord | undefined;
        const lines = contents.split(/\r?\n/u).filter(Boolean);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]!;
          if (!line) continue;
          if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new Error("Protected job journal line exceeds its limit");
          try {
            const envelope = JSON.parse(line) as ProtectedJobEnvelope;
            if (envelope.version !== 1 || typeof envelope.payload !== "string" || typeof envelope.signature !== "string" || !await this.#protector.verify(envelope.payload, envelope.signature)) throw new Error("Protected job journal signature is invalid");
            const plaintext = await this.#protector.unprotect(envelope.payload);
            if (Buffer.byteLength(plaintext, "utf8") > MAX_RECORD_BYTES) throw new Error("Protected job record exceeds its limit");
            latest = JSON.parse(plaintext) as JobRecord;
          } catch (error) {
            if (index !== lines.length - 1 || contents.endsWith("\n")) throw error;
            /* A process crash may leave only the final append truncated. */
          }
        }
        if (!latest?.jobId || !jobIdPattern.test(latest.jobId) || entry.name !== `${latest.jobId}.jsonl` || latest.schemaVersion !== 1 || !Array.isArray(latest.steps)) continue;
        if (latest.status === "running" || latest.status === "cancel_pending" || latest.status === "rolling_back" || latest.steps.some((step) => step.status === "running")) {
          latest = {
            ...latest,
            status: "reconciliation_required",
            updatedAt: new Date().toISOString(),
            error: { code: "INTERRUPTED_DISPATCH_BOUNDARY", message: "The process stopped while a job step may have crossed its dispatch boundary. Reconcile host state before retrying." },
            steps: latest.steps.map((step) => step.status === "running" ? { ...step, status: "reconciliation_required" } : step),
          };
          await this.append(latest);
        }
        this.#records.set(latest.jobId, clone(latest));
      } catch {
        // An unreadable job journal is not advertised as a valid job.
      }
    }
  }

  private async append(record: JobRecord): Promise<void> {
    const prior = this.#journalUpdate;
    const next = prior.catch(() => undefined).then(() => this.appendUnsafe(record));
    this.#journalUpdate = next;
    try { await next; }
    finally { if (this.#journalUpdate === next) this.#journalUpdate = Promise.resolve(); }
  }

  private async appendUnsafe(record: JobRecord): Promise<void> {
    const plaintext = JSON.stringify(record);
    if (Buffer.byteLength(plaintext, "utf8") > MAX_RECORD_BYTES) throw new Error("Job record exceeds the 700 KiB persistence limit");
    const payload = await this.#protector.protect(plaintext);
    const envelope: ProtectedJobEnvelope = { version: 1, payload, signature: await this.#protector.sign(payload) };
    const line = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new Error("Protected job record exceeds the journal line limit");
    const journalPath = join(this.#directory, `${record.jobId}.jsonl`);
    await this.withDirectoryLock(async () => {
      const entries = await readdir(this.#directory, { withFileTypes: true });
      const journals = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
      let existingSize = 0;
      try { existingSize = (await stat(journalPath)).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (existingSize === 0 && journals.length >= MAX_JOB_FILES) throw new Error("Job store reached the 1024-job file quota");
      let totalBytes = 0;
      for (const entry of journals) totalBytes += (await stat(join(this.#directory, entry.name))).size;
      if (totalBytes + Buffer.byteLength(line, "utf8") > MAX_DIRECTORY_BYTES) throw new Error("Job store reached the 256 MiB global quota");
      if (existingSize + Buffer.byteLength(line, "utf8") > MAX_JOURNAL_BYTES) throw new Error("Job journal reached the 64 MiB quota");
      const handle = await open(journalPath, "a", 0o600);
      try {
        await handle.appendFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  private async withDirectoryLock<T>(work: () => Promise<T>): Promise<T> {
    const lockPath = join(this.#directory, ".quota.lock");
    const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 200 && !lock; attempt += 1) {
      try {
        lock = await open(lockPath, "wx", 0o600);
        await lock.writeFile(owner, "utf8");
        await lock.sync();
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Never reap a lock automatically: checking an owner's liveness and
        // deleting a shared pathname cannot be made atomic with portable Node
        // filesystem APIs. A crash-stale lock therefore blocks writes and
        // requires explicit operator recovery instead of risking quota bypass.
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!lock) throw new Error("Job store quota lock is busy");
    try {
      return await work();
    } finally {
      await lock.close();
      try {
        if (await readFile(lockPath, "utf8") === owner) await rm(lockPath, { force: true });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  private async serial(jobId: string, work: () => Promise<void>): Promise<void> {
    const prior = this.#updates.get(jobId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(work);
    this.#updates.set(jobId, next);
    try { await next; }
    finally { if (this.#updates.get(jobId) === next) this.#updates.delete(jobId); }
  }
}
