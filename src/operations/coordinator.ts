import { randomUUID } from "node:crypto";
import { buildToolScript } from "../../vendor/upstream/bridge/script-builder.js";
import { wrapCepEvalScript } from "../bridge/cep-script.js";
import { assertRawExtendScriptReadOnly, assertToolWithinPolicy, assertTransportWithinPolicy, getToolPolicy } from "./tool-policy.js";
import { hashTarget, OperationLedger, payloadMetadata } from "./ledger.js";
import {
  MutationQuarantinedError, OperationExecutionUnknownError, OperationIdReusedError, OperationQueueDeadlineError,
  type HostSessionRef, type OperationBackend, type OperationCoordinatorStatus, type OperationLedgerEntry,
  type OperationMode, type OperationSnapshot, type OperationStatus, type ReconnectComparison,
} from "./types.js";

class DeadlineMutex {
  #locked = false;
  #waiters: Array<{ grant: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  get depth(): number { return this.#waiters.length + (this.#locked ? 1 : 0); }
  acquire(deadlineAt: number): Promise<() => void> {
    if (!this.#locked) { this.#locked = true; return Promise.resolve(this.#releaseOnce()); }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return Promise.reject(new OperationQueueDeadlineError());
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => resolve(this.#releaseOnce()), reject,
        timer: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new OperationQueueDeadlineError());
        }, remaining),
      };
      this.#waiters.push(waiter);
    });
  }
  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) { clearTimeout(next.timer); next.grant(); } else this.#locked = false;
    };
  }
}

export interface ScriptMetadataInput { sha256: string; bytes: number; source?: string }
export interface BeginOperationRequest {
  operationId?: string;
  toolName: string;
  backend: OperationBackend;
  mode: OperationMode;
  targetHint?: string;
  targetKind?: string;
  timeoutMs?: number;
  queueDeadlineMs?: number;
  script?: ScriptMetadataInput;
  args?: unknown;
  itemCount?: number;
  estimatedRiskyCalls?: number;
  hostSession?: HostSessionRef;
}
export interface CoordinatedOperation<T> extends BeginOperationRequest {
  preflight?: () => Promise<OperationSnapshot>;
  postflight?: (result: T) => Promise<OperationSnapshot>;
  executor: (context: { signal: AbortSignal; timeoutMs: number; operationId: string }) => Promise<T>;
}
interface ActiveOperation {
  base: Omit<OperationLedgerEntry, "recordedAt" | "status">;
  preSnapshot?: OperationSnapshot;
  targetHint?: string;
  targetKind?: string;
  requireActiveSequence: boolean;
  mutationRelease?: () => void;
  timeoutMs: number;
  queueDeadlineMs: number;
  rawExtendScriptSource?: string;
  deferredReleases: Array<() => void>;
  terminalStatus?: "UNKNOWN";
  finalization?: Promise<Extract<OperationStatus, "SUCCEEDED" | "FAILED" | "UNKNOWN">>;
}

type TerminalOperationStatus = Extract<OperationStatus, "SUCCEEDED" | "FAILED" | "UNKNOWN">;
const MAX_TERMINAL_RESULTS = 1_024;

function isoNow(): string { return new Date().toISOString(); }
function errorCode(error: unknown): string {
  const rec = error as { code?: unknown; name?: unknown } | null;
  return String(rec?.code ?? rec?.name ?? "OPERATION_FAILED").slice(0, 128);
}
function isUnknownFailure(error: unknown): boolean {
  const rec = error as { outcomeUnknown?: unknown } | null;
  if (rec?.outcomeUnknown === true) return true;
  const code = errorCode(error).toUpperCase();
  const message = String((error as { message?: unknown } | null)?.message ?? "").toUpperCase();
  return /TIMEOUT|TIMED_OUT|DISCONNECT|CLOSED|REPLACED|ABORT/.test(`${code} ${message}`);
}

export class OperationCoordinator {
  readonly #ledger: OperationLedger;
  readonly #cep = new DeadlineMutex();
  readonly #mutation = new DeadlineMutex();
  readonly #active = new Map<string, ActiveOperation>();
  readonly #terminalResults = new Map<string, TerminalOperationStatus>();
  #unknown = new Map<string, Awaited<ReturnType<OperationLedger["unresolvedUnknown"]>>[number]>();
  #usedOperationIds = new Set<string>();
  #loaded = false;
  constructor(ledger: OperationLedger) { this.#ledger = ledger; }

  #validateNested(request: BeginOperationRequest, active: ActiveOperation): void {
    if (active.terminalStatus === "UNKNOWN") throw new OperationExecutionUnknownError(active.base.operationId, `Operation '${active.base.operationId}' already has an unknown outcome`);
    if (request.toolName !== active.base.toolName && request.mode !== "read") throw new Error(`Operation '${active.base.operationId}' belongs to tool '${active.base.toolName}', not '${request.toolName}'`);
    if (active.base.mode === "read" && request.mode !== "read") throw new Error(`Read operation '${active.base.operationId}' cannot contain a mutation`);
    if (request.backend === "local") throw new Error("A host subrequest cannot use the local backend");
    const timeoutMs = request.timeoutMs ?? active.timeoutMs;
    if (timeoutMs > active.timeoutMs) throw new Error(`Operation '${active.base.operationId}' timeout exceeds its declared budget`);
    const args = payloadMetadata(request.args ?? {});
    const script = request.script ?? { sha256: payloadMetadata("").sha256, bytes: 0 };
    assertTransportWithinPolicy(request.toolName, {
      ...(script.source !== undefined ? { script: script.source } : {}),
      scriptBytes: script.bytes,
      argsBytes: args.bytes,
      itemCount: request.itemCount ?? 1,
      executionTimeoutMs: timeoutMs,
      queueDeadlineMs: request.queueDeadlineMs ?? active.queueDeadlineMs,
      ...(request.estimatedRiskyCalls !== undefined ? { estimatedRiskyCalls: request.estimatedRiskyCalls } : {}),
    });
    if (request.toolName === "execute_extendscript") {
      if (active.rawExtendScriptSource === undefined) throw new Error("execute_extendscript is missing its caller source at the daemon policy boundary");
      if (script.source === undefined) throw new Error("execute_extendscript requires the generated transport script at the daemon policy boundary");
      const expected = wrapCepEvalScript(buildToolScript(active.rawExtendScriptSource));
      if (script.source !== expected) {
        const expectedMeta = payloadMetadata(expected);
        const actualMeta = payloadMetadata(script.source);
        throw Object.assign(new Error(`Generated ExtendScript does not exactly match the validated caller source (expected ${expectedMeta.sha256}/${expectedMeta.bytes}, received ${actualMeta.sha256}/${actualMeta.bytes})`), {
          code: "SCRIPT_POLICY_BINDING_MISMATCH",
        });
      }
      if (active.base.mode === "read") assertRawExtendScriptReadOnly(request.toolName, active.rawExtendScriptSource);
    }
    if (script.bytes > 0 && (!active.base.script || active.base.script.bytes === 0)) {
      active.base.script = { sha256: script.sha256, bytes: script.bytes };
    }
  }

  validateActiveRequest(operationId: string, toolName: string, mode: OperationMode): void {
    const active = this.#active.get(operationId);
    if (!active) throw new Error(`Operation '${operationId}' is not active`);
    if (active.terminalStatus === "UNKNOWN") throw new OperationExecutionUnknownError(operationId, `Operation '${operationId}' already has an unknown outcome`);
    if (active.base.toolName !== toolName) throw new Error(`Operation '${operationId}' belongs to tool '${active.base.toolName}', not '${toolName}'`);
    if (active.base.mode !== mode) throw new Error(`Operation '${operationId}' is mode '${active.base.mode}', not '${mode}'`);
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#usedOperationIds = await this.#ledger.operationIds();
    // A process crash after QUEUED/RUNNING leaves the host-side outcome unknowable.
    // Promote only mutations; reads are safe to retry and must not quarantine edits.
    const latest = new Map<string, OperationLedgerEntry>();
    for (const entry of await this.#ledger.readEntries()) latest.set(entry.operationId, entry);
    for (const entry of latest.values()) {
      if (entry.mode !== "mutate" || (entry.status !== "QUEUED" && entry.status !== "RUNNING")) continue;
      await this.#ledger.append({ ...entry, recordedAt: isoNow(), status: "UNKNOWN", errorCode: "DAEMON_RESTART_OUTCOME_UNKNOWN" });
    }
    for (const item of await this.#ledger.unresolvedUnknown()) this.#unknown.set(item.operationId, item);
    this.#loaded = true;
  }

  #prepare(request: BeginOperationRequest): { operationId: string; timeoutMs: number; queueDeadlineMs: number; base: ActiveOperation["base"]; rawExtendScriptSource?: string } {
    const operationId = request.operationId ?? randomUUID();
    const policy = getToolPolicy(request.toolName);
    const explicitRawRead = request.toolName === "execute_extendscript" && request.mode === "read";
    if (policy.mode !== request.mode && !explicitRawRead) throw new Error(`${request.toolName} must execute as mode '${policy.mode}'`);
    if ((request.mode === "local") !== (request.backend === "local")) throw new Error("Operation mode and backend disagree");
    const timeoutMs = request.timeoutMs ?? policy.maxExecutionTimeoutMs;
    const queueDeadlineMs = request.queueDeadlineMs ?? policy.maxQueueDeadlineMs;
    const argsRecord = request.args && typeof request.args === "object" && !Array.isArray(request.args)
      ? request.args as Record<string, unknown>
      : undefined;
    const rawExtendScriptSource = request.toolName === "execute_extendscript" && typeof argsRecord?.code === "string"
      ? argsRecord.code
      : undefined;
    if (request.toolName === "execute_extendscript" && rawExtendScriptSource === undefined) {
      throw new Error("execute_extendscript requires its caller source in args.code at the daemon policy boundary");
    }
    if (explicitRawRead) assertRawExtendScriptReadOnly(request.toolName, rawExtendScriptSource!);
    const args = payloadMetadata(request.args ?? {});
    const requestScript = request.script ?? { sha256: payloadMetadata("").sha256, bytes: 0 };
    const script = rawExtendScriptSource !== undefined
      ? payloadMetadata(rawExtendScriptSource)
      : requestScript;
    assertToolWithinPolicy(request.toolName, {
      ...(rawExtendScriptSource !== undefined ? { script: rawExtendScriptSource } : requestScript.source !== undefined ? { script: requestScript.source } : {}), scriptBytes: script.bytes, argsBytes: args.bytes,
      itemCount: request.itemCount ?? 1, executionTimeoutMs: timeoutMs, queueDeadlineMs,
      ...(request.estimatedRiskyCalls !== undefined ? { estimatedRiskyCalls: request.estimatedRiskyCalls } : {}),
    });
    const base: ActiveOperation["base"] = {
      schemaVersion: 1, operationId, toolName: request.toolName, backend: request.backend, mode: request.mode,
      args, script: { sha256: script.sha256, bytes: script.bytes },
      ...(request.targetHint ? { target: hashTarget(request.targetHint, request.targetKind) } : {}),
      ...(request.hostSession ? { hostSession: request.hostSession } : {}),
    };
    return { operationId, timeoutMs, queueDeadlineMs, base, ...(rawExtendScriptSource !== undefined ? { rawExtendScriptSource } : {}) };
  }

  async beginOperation(request: BeginOperationRequest, preflightExecutor?: () => Promise<OperationSnapshot>): Promise<string> {
    await this.#load();
    if (request.operationId && this.#active.has(request.operationId)) {
      this.validateActiveRequest(request.operationId, request.toolName, request.mode);
      return request.operationId;
    }
    if (request.operationId && this.#usedOperationIds.has(request.operationId)) throw new OperationIdReusedError(request.operationId);
    if (request.mode === "mutate" && this.#unknown.size > 0) throw new MutationQuarantinedError();
    let operationId = request.operationId;
    while (!operationId || this.#usedOperationIds.has(operationId)) operationId = randomUUID();
    const prepared = this.#prepare({ ...request, operationId });
    this.#usedOperationIds.add(prepared.operationId);
    await this.#ledger.append({ ...prepared.base, recordedAt: isoNow(), status: "QUEUED" });
    let mutationRelease: (() => void) | undefined;
    try {
      if (request.mode === "mutate") mutationRelease = await this.#mutation.acquire(Date.now() + prepared.queueDeadlineMs);
      const policy = getToolPolicy(request.toolName);
      if (request.mode === "mutate" && policy.checkpoint !== "none" && !preflightExecutor) throw new Error(`${request.toolName} requires a preflight snapshot`);
      const preSnapshot = await preflightExecutor?.();
      const resolvedSequenceId = preSnapshot?.resolvedSequenceId;
      const useResolvedSequence = Boolean(resolvedSequenceId && (request.targetKind === "sequence" || request.targetKind === "clip"));
      const active: ActiveOperation = {
        base: prepared.base, timeoutMs: prepared.timeoutMs, queueDeadlineMs: prepared.queueDeadlineMs, deferredReleases: [],
        ...(prepared.rawExtendScriptSource !== undefined ? { rawExtendScriptSource: prepared.rawExtendScriptSource } : {}),
        requireActiveSequence: request.targetKind === "clip" || (request.targetKind === "sequence" && request.targetHint === "active-sequence"),
        ...(preSnapshot ? { preSnapshot } : {}), ...(mutationRelease ? { mutationRelease } : {}),
        ...((useResolvedSequence ? resolvedSequenceId : request.targetHint) ? { targetHint: useResolvedSequence ? resolvedSequenceId! : request.targetHint! } : {}),
        ...((useResolvedSequence ? "sequence" : request.targetKind) ? { targetKind: useResolvedSequence ? "sequence" : request.targetKind! } : {}),
      };
      this.#active.set(prepared.operationId, active);
      await this.#ledger.append({ ...prepared.base, recordedAt: isoNow(), status: "RUNNING", ...(preSnapshot ? { preSnapshot } : {}) });
      return prepared.operationId;
    } catch (error) {
      mutationRelease?.();
      await this.#ledger.append({ ...prepared.base, recordedAt: isoNow(), status: "FAILED", errorCode: errorCode(error) });
      throw error;
    }
  }

  #rememberTerminal(operationId: string, status: TerminalOperationStatus): void {
    this.#terminalResults.set(operationId, status);
    while (this.#terminalResults.size > MAX_TERMINAL_RESULTS) {
      const oldest = this.#terminalResults.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#terminalResults.delete(oldest);
    }
  }

  async #finalizeOperation(active: ActiveOperation, status: TerminalOperationStatus, postflight?: () => Promise<OperationSnapshot>, failureCode?: string): Promise<TerminalOperationStatus> {
    const operationId = active.base.operationId;
    const policy = getToolPolicy(active.base.toolName);
    let finalStatus: TerminalOperationStatus = active.base.mode === "read" && status === "UNKNOWN" ? "FAILED" : status;
    let postSnapshot: OperationSnapshot | undefined;
    let code = failureCode;
    if (status === "SUCCEEDED" && active.base.mode === "mutate") {
      try {
        if (policy.checkpoint === "before-and-after" && !postflight) throw new Error(`${active.base.toolName} requires a postflight snapshot`);
        postSnapshot = await postflight?.();
      } catch (error) {
        finalStatus = "UNKNOWN";
        code = errorCode(error);
      }
    }
    await this.#ledger.append({
      ...active.base, recordedAt: isoNow(), status: finalStatus, ...(active.preSnapshot ? { preSnapshot: active.preSnapshot } : {}),
      ...(postSnapshot ? { postSnapshot } : {}), ...(policy.checkpoint === "save-boundary" && finalStatus === "SUCCEEDED" ? { saveAt: isoNow() } : {}),
      ...(code ? { errorCode: code } : {}),
    });
    this.#rememberTerminal(operationId, finalStatus);
    if (finalStatus === "UNKNOWN" && active.base.mode === "mutate") {
      active.terminalStatus = "UNKNOWN";
      const summary = (await this.#ledger.unresolvedUnknown()).find((item) => item.operationId === operationId);
      if (summary) this.#unknown.set(operationId, summary);
      // The operation-level mutation lease remains held as quarantine, but the
      // CEP execution lease must be released so read-only diagnosis can run.
      for (const release of active.deferredReleases.splice(0)) release();
      return finalStatus;
    }
    this.#active.delete(operationId);
    active.mutationRelease?.();
    for (const release of active.deferredReleases.splice(0)) release();
    return finalStatus;
  }

  async endOperation(operationId: string, status: TerminalOperationStatus, postflight?: () => Promise<OperationSnapshot>, failureCode?: string): Promise<TerminalOperationStatus> {
    const completed = this.#terminalResults.get(operationId);
    if (completed) return completed;
    const active = this.#active.get(operationId);
    if (!active) throw new Error(`Operation '${operationId}' is not active`);
    if (active.finalization) return active.finalization;
    const finalization = this.#finalizeOperation(active, status, postflight, failureCode);
    active.finalization = finalization;
    return finalization;
  }

  async execute<T>(request: CoordinatedOperation<T>): Promise<T> {
    await this.#load();
    const nested = Boolean(request.operationId && this.#active.has(request.operationId));
    if (nested) this.#validateNested(request, this.#active.get(request.operationId!)!);
    const operationId = nested ? request.operationId! : await this.beginOperation(request, request.preflight);
    const active = this.#active.get(operationId)!;
    let cepRelease: (() => void) | undefined;
    try {
      if (request.backend === "cep") cepRelease = await this.#cep.acquire(Date.now() + (request.queueDeadlineMs ?? active.queueDeadlineMs));
      const timeoutMs = request.timeoutMs ?? active.timeoutMs;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const execution = Promise.resolve().then(() => request.executor({ signal: controller.signal, timeoutMs, operationId }));
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error(`Operation execution exceeded ${timeoutMs}ms`) as Error & { code: string };
          error.code = "EXECUTION_TIMEOUT";
          reject(error);
        }, timeoutMs);
      });
      try {
        const result = await Promise.race([execution, timeout]);
        if (!nested) {
          const finalStatus = await this.endOperation(operationId, "SUCCEEDED", request.postflight ? () => request.postflight!(result) : undefined);
          if (finalStatus === "UNKNOWN") throw new OperationExecutionUnknownError(operationId, "Postflight state could not be established");
        }
        return result;
      } finally { if (timer) clearTimeout(timer); }
    } catch (error) {
      if (error instanceof OperationExecutionUnknownError) throw error;
      const unknown = active.base.mode === "mutate" && isUnknownFailure(error);
      if (unknown && cepRelease) {
        this.#active.get(operationId)?.deferredReleases.push(cepRelease);
        cepRelease = undefined;
      }
      if (this.#active.has(operationId) && (unknown || !nested)) await this.endOperation(operationId, unknown ? "UNKNOWN" : "FAILED", undefined, errorCode(error));
      if (unknown) throw new OperationExecutionUnknownError(operationId, String((error as Error).message ?? error));
      throw error;
    } finally { cepRelease?.(); }
  }

  async getRecoveryStatus(): Promise<OperationCoordinatorStatus> {
    await this.#load();
    return { quarantined: this.#unknown.size > 0, unresolved: [...this.#unknown.values()], cepQueueDepth: this.#cep.depth, mutationQueueDepth: this.#mutation.depth };
  }
  snapshotTarget(operationId: string): { targetHint?: string; targetKind?: string; requireActiveSequence: boolean; toolName: string; preSnapshot?: OperationSnapshot } {
    const active = this.#active.get(operationId);
    if (!active) throw new Error(`Operation '${operationId}' is not active`);
    return {
      ...(active.targetHint ? { targetHint: active.targetHint } : {}),
      ...(active.targetKind ? { targetKind: active.targetKind } : {}),
      requireActiveSequence: active.requireActiveSequence,
      toolName: active.base.toolName,
      ...(active.preSnapshot ? { preSnapshot: active.preSnapshot } : {}),
    };
  }
  async compareReconnect(operationId: string, current: OperationSnapshot): Promise<ReconnectComparison> {
    await this.#load();
    const unknown = this.#unknown.get(operationId);
    if (!unknown) throw new Error(`Operation '${operationId}' is not unresolved`);
    if (!unknown.preFingerprint) return "NO_PRE_SNAPSHOT";
    if (unknown.preProjectionVersion === undefined || current.projectionVersion === undefined || unknown.preProjectionVersion !== current.projectionVersion) return "INCOMPARABLE_PROJECTION";
    return unknown.preFingerprint === current.fingerprint ? "BOUNDED_MATCH" : "CHANGED_FROM_PRE";
  }
  async acknowledgeUnknown(input: { operationId: string; expectedFingerprint: string; observedFingerprint: string }): Promise<void> {
    await this.#load();
    const unknown = this.#unknown.get(input.operationId);
    if (!unknown) throw new Error(`Operation '${input.operationId}' is not unresolved`);
    if (!input.expectedFingerprint || input.expectedFingerprint !== input.observedFingerprint) throw new Error("Recovery acknowledgement fingerprint mismatch");
    await this.#ledger.append({
      schemaVersion: 1, operationId: unknown.operationId, recordedAt: isoNow(), toolName: unknown.toolName,
      backend: unknown.backend, mode: "mutate", status: "ACKNOWLEDGED", ...(unknown.target ? { target: unknown.target } : {}),
      ...(unknown.hostSession ? { hostSession: unknown.hostSession } : {}),
    });
    this.#unknown.delete(input.operationId);
    const active = this.#active.get(input.operationId);
    active?.mutationRelease?.();
    for (const release of active?.deferredReleases.splice(0) ?? []) release();
    this.#active.delete(input.operationId);
  }
}
