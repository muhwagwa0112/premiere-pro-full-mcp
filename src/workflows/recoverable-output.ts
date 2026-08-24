import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface OutputSnapshot { bytes: number; sha256: string }
export interface RecoverableOutputPaths { finalPath: string; temporaryPath: string; backupPath: string }
export type RecoveryPhase = "unopened" | "prepared" | "original_backed_up" | "temporary_verified" | "final_committed" | "backup_removed" | "restored";
export interface ReconciliationEvidence {
  state: "reconciliation_required";
  finalPathDigest: string;
  temporaryPathDigest: string;
  backupPathDigest: string;
  journalPathDigest: string;
  lockDigest: string;
  originalWasBackedUp: boolean;
  phase: RecoveryPhase;
}

interface RecoveryJournalHeader {
  schemaVersion: 1;
  type: "recoverable-output";
  operationId: string;
  canonicalFinalPath: string;
  temporaryPath: string;
  backupPath: string;
  original: OutputSnapshot | null;
  phase: "prepared";
  createdAt: string;
}

export class RecoverableOutputError extends Error {
  constructor(readonly code: string, message: string, readonly evidence: ReconciliationEvidence, options?: { cause?: unknown }) {
    super(message, options);
  }
}

function pathDigest(path: string): string {
  return `sha256:${createHash("sha256").update(path).digest("hex")}`;
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function snapshot(path: string, requireNonEmpty: boolean): Promise<OutputSnapshot> {
  const metadata = await stat(path);
  if (!metadata.isFile() || (requireNonEmpty && metadata.size < 1)) throw new Error("Export output is missing, empty, or not a regular file");
  const bytes = await readFile(path);
  return { bytes: metadata.size, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

function snapshotsEqual(left: OutputSnapshot, right: OutputSnapshot): boolean {
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync().catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EINVAL" && code !== "EBADF")) throw error;
    });
  } finally { await directory.close(); }
}

async function syncFile(path: string): Promise<void> {
  const target = await open(path, "r+");
  try {
    await target.sync().catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EINVAL" && code !== "EBADF")) throw error;
    });
  } finally { await target.close(); }
}

async function durableRename(from: string, to: string): Promise<void> {
  await rename(from, to);
  await syncFile(to);
  await syncDirectory(dirname(to));
}

async function durableRemove(path: string): Promise<void> {
  await rm(path);
  await syncDirectory(dirname(path));
}

async function createJournalAtomically(path: string, header: RecoveryJournalHeader): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(header)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try {
    // A same-filesystem hard link publishes a fully fsynced journal without
    // replacing an existing canonical-output lock.
    await link(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function appendJournalPhase(path: string, phase: RecoveryPhase): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.writeFile(`${JSON.stringify({ phase, timestamp: new Date().toISOString() })}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}

async function assertNoReparseComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let cursor = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const metadata = await lstat(cursor);
    if (metadata.isSymbolicLink()) throw new Error("Output path crosses a symbolic link or reparse point");
  }
}

async function canonicalOutputPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Recoverable output path must be absolute");
  const absolute = resolve(path);
  const suppliedDirectory = dirname(absolute);
  await assertNoReparseComponents(suppliedDirectory);
  const canonicalDirectory = await realpath(suppliedDirectory);
  await assertNoReparseComponents(canonicalDirectory);
  const canonical = join(canonicalDirectory, basename(absolute));
  if (await exists(absolute)) {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("Recoverable output must be a regular non-reparse file");
    if (!pathsEqual(await realpath(absolute), canonical)) throw new Error("Recoverable output identity changed during canonicalization");
  }
  return canonical;
}

async function assertDirectoryIdentity(path: string, canonicalDirectory: string): Promise<void> {
  await assertNoReparseComponents(path);
  const current = await realpath(path);
  if (!pathsEqual(current, canonicalDirectory)) throw new Error("Recoverable output directory identity changed");
}

async function assertTargetIdentity(path: string, canonicalDirectory: string, state: "file" | "missing" | "either"): Promise<boolean> {
  await assertDirectoryIdentity(dirname(path), canonicalDirectory);
  const present = await exists(path);
  if (!present) {
    if (state === "file") throw new Error("Required recovery file is missing");
    return false;
  }
  if (state === "missing") throw new Error("A recovery target unexpectedly exists");
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("Recovery target is not a regular non-reparse file");
  const expected = join(canonicalDirectory, basename(path));
  if (!pathsEqual(await realpath(path), expected)) throw new Error("Recovery target identity changed");
  return true;
}

export function recoverableOutputPaths(finalPath: string, operationId: string): RecoverableOutputPaths {
  const absoluteFinalPath = resolve(finalPath);
  const extension = extname(absoluteFinalPath);
  const stem = basename(absoluteFinalPath, extension);
  const directory = dirname(absoluteFinalPath);
  const suffix = operationId.replaceAll("-", "");
  return {
    finalPath: absoluteFinalPath,
    temporaryPath: join(directory, `${stem}.ppmcp-${suffix}.tmp${extension}`),
    backupPath: join(directory, `${stem}.ppmcp-${suffix}.backup${extension}`),
  };
}

/** Resolve the exact non-reparse output identity used by planning and dispatch. */
export async function canonicalRecoverableOutputPaths(finalPath: string, operationId: string): Promise<RecoverableOutputPaths> {
  return recoverableOutputPaths(await canonicalOutputPath(finalPath), operationId);
}

export class RecoverableOutput {
  readonly paths: RecoverableOutputPaths;
  readonly #stableDelayMs: number;
  readonly #operationId: string;
  #begun = false;
  #originalWasBackedUp = false;
  #originalSnapshot: OutputSnapshot | null = null;
  #canonicalDirectory: string | null = null;
  #journalPath: string | null = null;
  #phase: RecoveryPhase = "unopened";
  #publishedFinal = false;
  #commitIrreversible = false;

  constructor(finalPath: string, operationId: string, options: { stableDelayMs?: number } = {}) {
    this.paths = recoverableOutputPaths(finalPath, operationId);
    this.#operationId = operationId;
    this.#stableDelayMs = options.stableDelayMs ?? 100;
    if (!Number.isSafeInteger(this.#stableDelayMs) || this.#stableDelayMs < 0) throw new Error("Stable-file verification delay must be a non-negative integer");
  }

  get journalPath(): string | null { return this.#journalPath; }

  static async assertNoUnfinishedTransaction(finalPath: string): Promise<void> {
    const canonicalFinalPath = await canonicalOutputPath(finalPath);
    const journalPath = journalPathFor(canonicalFinalPath);
    if (await exists(journalPath)) {
      const paths = recoverableOutputPaths(canonicalFinalPath, "unknown");
      throw new RecoverableOutputError("OUTPUT_RECOVERY_QUARANTINED", "An unfinished recovery transaction already owns this output", evidenceFor(paths, journalPath, false, "prepared"));
    }
  }

  async begin(): Promise<string> {
    if (this.#begun) throw new Error("Recoverable output transaction has already begun");
    let canonicalFinalPath: string;
    try { canonicalFinalPath = await canonicalOutputPath(this.paths.finalPath); }
    catch (error) { throw this.error("OUTPUT_RECOVERY_PATH_UNSAFE", (error as Error).message, error); }
    Object.assign(this.paths, recoverableOutputPaths(canonicalFinalPath, this.#operationId));
    this.#canonicalDirectory = dirname(canonicalFinalPath);
    this.#journalPath = journalPathFor(canonicalFinalPath);

    if (await exists(this.#journalPath)) throw this.error("OUTPUT_RECOVERY_QUARANTINED", "An unfinished recovery transaction already owns this output");
    try {
      if (await assertTargetIdentity(this.paths.temporaryPath, this.#canonicalDirectory, "either") || await assertTargetIdentity(this.paths.backupPath, this.#canonicalDirectory, "either")) {
        throw new Error("Stale recovery artifacts exist for this operation; reconciliation is required");
      }
      const originalExists = await assertTargetIdentity(this.paths.finalPath, this.#canonicalDirectory, "either");
      this.#originalSnapshot = originalExists ? await snapshot(this.paths.finalPath, false) : null;
      const header: RecoveryJournalHeader = {
        schemaVersion: 1, type: "recoverable-output", operationId: this.#operationId,
        canonicalFinalPath: this.paths.finalPath, temporaryPath: this.paths.temporaryPath, backupPath: this.paths.backupPath,
        original: this.#originalSnapshot, phase: "prepared", createdAt: new Date().toISOString(),
      };
      await createJournalAtomically(this.#journalPath, header);
      this.#begun = true;
      this.#phase = "prepared";
      if (this.#originalSnapshot) {
        await assertTargetIdentity(this.paths.backupPath, this.#canonicalDirectory, "missing");
        // Revalidate the source last, immediately before the destructive move.
        await this.assertOriginalStillMatches();
        await durableRename(this.paths.finalPath, this.paths.backupPath);
        this.#originalWasBackedUp = true;
        const backup = await snapshot(this.paths.backupPath, false);
        if (!snapshotsEqual(backup, this.#originalSnapshot)) throw new Error("Backed-up output did not match the original snapshot");
        await this.advance("original_backed_up");
      }
      return this.paths.temporaryPath;
    } catch (error) {
      if (error instanceof RecoverableOutputError) throw error;
      if (this.#begun) throw this.error("OUTPUT_RECOVERY_PREPARE_REQUIRES_RECONCILIATION", "Recoverable output preparation could not complete safely", error);
      throw this.error("OUTPUT_RECOVERY_PREPARE_FAILED", (error as Error).message, error);
    }
  }

  async complete(): Promise<OutputSnapshot> {
    this.assertBegun();
    try {
      await assertTargetIdentity(this.paths.temporaryPath, this.directory(), "file");
      const first = await snapshot(this.paths.temporaryPath, true);
      if (this.#stableDelayMs > 0) await delay(this.#stableDelayMs);
      await assertTargetIdentity(this.paths.temporaryPath, this.directory(), "file");
      const second = await snapshot(this.paths.temporaryPath, true);
      if (!snapshotsEqual(first, second)) throw new Error("Export output did not remain stable during verification");
      await this.advance("temporary_verified");
      await assertTargetIdentity(this.paths.finalPath, this.directory(), "missing");
      await link(this.paths.temporaryPath, this.paths.finalPath);
      this.#publishedFinal = true;
      await syncFile(this.paths.finalPath);
      await syncDirectory(this.directory());
      await assertTargetIdentity(this.paths.temporaryPath, this.directory(), "file");
      await durableRemove(this.paths.temporaryPath);
      const committed = await snapshot(this.paths.finalPath, true);
      if (!snapshotsEqual(committed, second)) throw new Error("Committed output did not match the verified temporary output");
      await this.advance("final_committed");
      if (this.#originalWasBackedUp) {
        await this.assertBackupMatchesOriginal();
        await assertTargetIdentity(this.paths.backupPath, this.directory(), "file");
        await durableRemove(this.paths.backupPath);
        // Once the verified original backup is deliberately removed, rollback
        // is no longer possible. Any later failure must preserve the committed
        // final and keep the journal quarantine instead of attempting restore.
        this.#commitIrreversible = true;
        this.#originalWasBackedUp = false;
        this.#phase = "backup_removed";
        try { await appendJournalPhase(this.journal(), "backup_removed"); }
        catch (error) { throw this.error("OUTPUT_RECOVERY_CLEANUP_FAILED", "Committed output is valid but its final journal phase could not be persisted", error); }
      } else {
        // With no prior output there is nothing to restore after the committed
        // phase. A journal-cleanup failure must not delete the new final.
        this.#commitIrreversible = true;
      }
      await this.removeJournal();
      this.#begun = false;
      return second;
    } catch (error) {
      if (this.#commitIrreversible) {
        if (error instanceof RecoverableOutputError) throw error;
        throw this.error("OUTPUT_RECOVERY_CLEANUP_FAILED", "Committed output is valid but recovery cleanup did not finish", error);
      }
      if (error instanceof RecoverableOutputError && error.code === "OUTPUT_RECOVERY_CLEANUP_FAILED") throw error;
      try { await this.restoreKnownFailure(); }
      catch (recoveryError) { throw recoveryError; }
      throw error;
    }
  }

  async restoreKnownFailure(): Promise<void> {
    if (!this.#begun) return;
    if (this.#commitIrreversible) {
      throw this.error(
        "OUTPUT_RECOVERY_CLEANUP_FAILED",
        "Committed output is valid and cannot be rolled back after verified backup removal"
      );
    }
    try {
      if (this.#originalWasBackedUp) await this.assertBackupMatchesOriginal();
      if (await assertTargetIdentity(this.paths.temporaryPath, this.directory(), "either")) await durableRemove(this.paths.temporaryPath);
      const finalExists = await assertTargetIdentity(this.paths.finalPath, this.directory(), "either");
      if (this.#publishedFinal && finalExists) {
        await durableRemove(this.paths.finalPath);
        this.#publishedFinal = false;
      } else if (this.#originalWasBackedUp && finalExists) {
        throw new Error("A concurrent file appeared at the final output path during recovery");
      }
      if (this.#originalWasBackedUp) {
        await assertTargetIdentity(this.paths.finalPath, this.directory(), "missing");
        await this.assertBackupMatchesOriginal();
        await durableRename(this.paths.backupPath, this.paths.finalPath);
        const restored = await snapshot(this.paths.finalPath, false);
        if (!this.#originalSnapshot || !snapshotsEqual(restored, this.#originalSnapshot)) throw new Error("Restored output did not match the original snapshot");
        this.#originalWasBackedUp = false;
      }
      await this.advance("restored");
      await this.removeJournal();
      this.#begun = false;
    } catch (error) {
      if (error instanceof RecoverableOutputError) throw error;
      throw this.error("OUTPUT_RECOVERY_RESTORE_FAILED", "The original output could not be proven restored", error);
    }
  }

  reconciliationEvidence(): ReconciliationEvidence {
    this.assertBegun();
    return this.currentEvidence();
  }

  private async assertOriginalStillMatches(): Promise<void> {
    await assertTargetIdentity(this.paths.finalPath, this.directory(), "file");
    const current = await snapshot(this.paths.finalPath, false);
    if (!this.#originalSnapshot || !snapshotsEqual(current, this.#originalSnapshot)) throw new Error("Original output changed before backup rename");
  }

  private async assertBackupMatchesOriginal(): Promise<void> {
    await assertTargetIdentity(this.paths.backupPath, this.directory(), "file");
    const backup = await snapshot(this.paths.backupPath, false);
    if (!this.#originalSnapshot || !snapshotsEqual(backup, this.#originalSnapshot)) throw new Error("Recovery backup is missing or does not match the original snapshot");
  }

  private async advance(phase: Exclude<RecoveryPhase, "unopened">): Promise<void> {
    await appendJournalPhase(this.journal(), phase);
    this.#phase = phase;
  }

  private async removeJournal(): Promise<void> {
    try {
      await assertTargetIdentity(this.journal(), this.directory(), "file");
      await durableRemove(this.journal());
    } catch (error) {
      throw this.error("OUTPUT_RECOVERY_CLEANUP_FAILED", "Recovery state is safe but its durable quarantine journal could not be removed", error);
    }
  }

  private currentEvidence(): ReconciliationEvidence {
    return evidenceFor(this.paths, this.#journalPath ?? join(dirname(this.paths.finalPath), ".ppmcp-recovery-unopened.jsonl"), this.#originalWasBackedUp, this.#phase);
  }

  private error(code: string, message: string, cause?: unknown): RecoverableOutputError {
    return new RecoverableOutputError(code, message, this.currentEvidence(), { cause });
  }

  private directory(): string {
    if (!this.#canonicalDirectory) throw new Error("Recoverable output directory is not initialized");
    return this.#canonicalDirectory;
  }

  private journal(): string {
    if (!this.#journalPath) throw new Error("Recoverable output journal is not initialized");
    return this.#journalPath;
  }

  private assertBegun(): void {
    if (!this.#begun) throw new Error("Recoverable output transaction has not begun");
  }
}

function journalPathFor(canonicalFinalPath: string): string {
  const digest = pathDigest(canonicalFinalPath).slice("sha256:".length);
  return join(dirname(canonicalFinalPath), `.ppmcp-recovery-${digest}.jsonl`);
}

function evidenceFor(paths: RecoverableOutputPaths, journalPath: string, originalWasBackedUp: boolean, phase: RecoveryPhase): ReconciliationEvidence {
  const journalPathDigest = pathDigest(journalPath);
  return {
    state: "reconciliation_required",
    finalPathDigest: pathDigest(paths.finalPath), temporaryPathDigest: pathDigest(paths.temporaryPath),
    backupPathDigest: pathDigest(paths.backupPath), journalPathDigest, lockDigest: journalPathDigest,
    originalWasBackedUp, phase,
  };
}
