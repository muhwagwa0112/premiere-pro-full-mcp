import { randomUUID } from "node:crypto";
import { actionRequestSchema, type ActionRequest, type Authority, type Backend, type BackendAdapter, type BackendProbe, type BridgeResponse, type OperationResult, type ReconciliationPhase, type Risk } from "./contracts.js";
import { getAction, listActions, validateActionArgs } from "./catalog.js";
import { OperationLedger } from "./ledger.js";
import { readFile, stat } from "node:fs/promises";
import { PathPolicy } from "./security/path-policy.js";
import { pathArgumentsForEntry, validateAdobeRuntimeCall } from "./adobe-api-catalog.js";
import { AuthorizationError, AuthorizationService } from "./security/authorization-service.js";
import { buildExecutionPlan, effectiveBridgeRequestDigest, routeBindingFromProbe, sameRouteBinding, sha256Canonical, type ExecutionPlan } from "./security/execution-plan.js";
import type { ActionDescriptor } from "./contracts.js";
import { CheckpointError, createCheckpoint } from "./workflows/checkpoint.js";
import { canonicalRecoverableOutputPaths, RecoverableOutput, RecoverableOutputError, type RecoverableOutputPaths } from "./workflows/recoverable-output.js";

interface AdobeInventorySummary {
  source: unknown;
  fingerprint: string;
  counts: unknown;
}

interface PreparedOperation {
  request: ActionRequest;
  action: ActionDescriptor;
  paths: string[];
  approvedRootDigests: string[];
  candidates: Array<{ backend: Backend; adapter: BackendAdapter; probe: BackendProbe }>;
  selected: { backend: Backend; adapter: BackendAdapter; probe: BackendProbe };
  recoverableOutputPaths: RecoverableOutputPaths | null;
  effectiveDispatchArgs: Record<string, unknown>;
  plan: ExecutionPlan;
}

interface PendingFallback {
  normalizedRequestDigest: string;
  attemptedBackends: Backend[];
}

function collectPathValues(value: unknown, key = ""): string[] {
  if (typeof value === "string") return /path(s)?$/iu.test(key) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectPathValues(item, key));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([childKey, child]) => collectPathValues(child, childKey));
}

async function adobeInventorySummary(): Promise<AdobeInventorySummary | { status: "not_generated" }> {
  try {
    const parsed = JSON.parse(await readFile(new URL("../generated/adobe-uxp-api.json", import.meta.url), "utf8")) as AdobeInventorySummary;
    return { source: parsed.source, fingerprint: parsed.fingerprint, counts: parsed.counts };
  } catch {
    return { status: "not_generated" };
  }
}

function enabledAuthorities(): Set<Authority> {
  const configured = process.env.PREMIERE_MCP_AUTHORITIES ?? "inspect,edit,filesystem,experimental,cloud";
  const allowed: Authority[] = ["inspect", "edit", "filesystem", "experimental", "cloud"];
  return new Set(configured.split(",").map((item) => item.trim()).filter((item): item is Authority => allowed.includes(item as Authority)));
}

async function assertOutputPolicy(actionId: string, args: Record<string, unknown>): Promise<void> {
  if (actionId !== "export.sequence" || args.overwrite === true || typeof args.outputPath !== "string") return;
  try {
    const existing = await stat(args.outputPath);
    if (existing.isFile() || existing.isDirectory()) throw new Error("Sequence export refused to overwrite an existing output path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function executionPreconditions(paths: RecoverableOutputPaths | null): string[] {
  return paths ? [`recoverable-output:v1:${sha256Canonical(paths)}`] : [];
}

function effectiveDispatchArgs(args: Record<string, unknown>, paths: RecoverableOutputPaths | null): Record<string, unknown> {
  return paths ? { ...args, outputPath: paths.temporaryPath, overwrite: false } : args;
}

export class OperationEngine {
  readonly #adapters: Map<Backend, BackendAdapter>;
  readonly #ledger: OperationLedger;
  readonly #authorities: Set<Authority>;
  readonly #pathPolicy: PathPolicy;
  readonly #authorization: Promise<AuthorizationService>;
  readonly #pendingFallbacks = new Map<string, PendingFallback>();
  readonly #inFlightOperationIds = new Set<string>();
  #localReconciliationRequired = false;

  constructor(adapters: BackendAdapter[], options: { authorizationService?: AuthorizationService | Promise<AuthorizationService>; ledger?: OperationLedger; authorities?: Set<Authority>; pathPolicy?: PathPolicy } = {}) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.backend, adapter]));
    this.#ledger = options.ledger ?? new OperationLedger();
    this.#authorities = options.authorities ?? enabledAuthorities();
    this.#pathPolicy = options.pathPolicy ?? new PathPolicy();
    this.#authorization = options.authorizationService ? Promise.resolve(options.authorizationService) : AuthorizationService.createFromEnvironment();
  }

  async capabilities(): Promise<Record<string, unknown>> {
    const backendEntries = await Promise.all([...this.#adapters.entries()].map(async ([backend, adapter]) => {
      const probe = await adapter.probe();
      return [backend, probe] as const;
    }));
    const backends = Object.fromEntries(backendEntries);
    return {
      server: { name: "premiere-pro-full-mcp", version: "0.3.0", transport: "stdio" },
      target: { product: "Adobe Premiere Pro 2026", version: "26.3.2", platform: "win32" },
      authorities: [...this.#authorities].sort(),
      backends,
      adobeUxpInventory: await adobeInventorySummary(),
      actions: listActions().map((action) => ({
        id: action.id,
        domain: action.domain,
        title: action.title,
        risk: action.risk,
        authority: action.authority,
        preferredBackends: action.preferredBackends,
        support: action.support,
        mutatesProject: action.mutatesProject,
        undoable: action.undoable,
        minimumPremiereVersion: action.minimumPremiereVersion,
        verification: action.verification,
        enabled: this.#authorities.has(action.authority),
      })),
      fallbackPolicy: "Fix the supported route before authorization. Only explicit not_dispatched may fallback; accepted, completed, and unknown are never replayed. A consumed interactive approval never covers a changed backend.",
      liveHostClaims: "unverified_until_exercised",
    };
  }

  async preview(input: unknown): Promise<Record<string, unknown>> {
    const pendingFallback = this.pendingFallbackFor(input);
    const prepared = await this.prepare(input, pendingFallback?.attemptedBackends ?? []);
    this.assertPendingFallbackRequest(prepared, pendingFallback);
    const authorization = await this.#authorization;
    return {
      operationId: prepared.request.operationId, planHash: prepared.plan.planHash, backend: prepared.selected.backend,
      actionId: prepared.action.id, risk: prepared.action.risk,
      ...await authorization.preview(prepared.action, prepared.request, prepared.plan),
    };
  }

  async execute(input: unknown): Promise<OperationResult> {
    const parsed = actionRequestSchema.safeParse(input);
    const parsedRequest = parsed.success ? parsed.data : undefined;
    const suppliedOperationId = parsedRequest?.operationId;
    if (suppliedOperationId && this.#inFlightOperationIds.has(suppliedOperationId)) {
      let risk: Risk = "R0";
      try { risk = getAction(parsedRequest!.actionId).risk; } catch { /* The duplicate boundary remains authoritative. */ }
      return this.failureResult(suppliedOperationId, parsedRequest!.actionId, risk, null, "DUPLICATE_OPERATION_IN_FLIGHT", "operationId is already owned by another in-flight request", false, "blocked");
    }
    if (suppliedOperationId) this.#inFlightOperationIds.add(suppliedOperationId);
    try { return await this.executeOwned(input); }
    finally { if (suppliedOperationId) this.#inFlightOperationIds.delete(suppliedOperationId); }
  }

  private async executeOwned(input: unknown): Promise<OperationResult> {
    const pendingFallback = this.pendingFallbackFor(input);
    let prepared: PreparedOperation;
    try {
      prepared = await this.prepare(input, pendingFallback?.attemptedBackends ?? []);
      this.assertPendingFallbackRequest(prepared, pendingFallback);
    } catch (error) {
      return this.invalidRequestResult(input, error as Error);
    }
    const { request, action } = prepared;
    const operationId = request.operationId!;

    const previous = await this.#ledger.get(operationId);
    if (previous && !(pendingFallback && previous.status === "planned")) {
      return this.failureResult(operationId, action.id, action.risk, previous.backend, "DUPLICATE_OPERATION", `operationId already recorded with status ${previous.status}`, false, "blocked");
    }

    if (request.planHash && request.planHash !== prepared.plan.planHash) return this.failureResult(operationId, action.id, action.risk, prepared.selected.backend, "PLAN_DRIFT", "The supplied planHash no longer matches the exact prepared route, arguments, session, roots, state, or verifier", false, "blocked");
    const authorization = await this.#authorization;
    let lastNotDispatched: { backend: Backend; response: BridgeResponse } | null = null;
    for (let index = 0; index < prepared.candidates.length; index++) {
      const candidate = prepared.candidates[index]!;
      const plan = index === 0 ? prepared.plan : buildExecutionPlan({
        action, request, probe: candidate.probe, approvedRootDigests: prepared.approvedRootDigests,
        preconditions: prepared.plan.preconditions, checkpointRequired: prepared.plan.checkpointRequired,
        effectiveArgs: prepared.effectiveDispatchArgs,
      });
      let grant;
      try { grant = await authorization.authorize(action, request, plan, prepared.paths); }
      catch (error) {
        const auth = error instanceof AuthorizationError ? error : new AuthorizationError("AUTHORIZATION_FAILED", (error as Error).message);
        if (index > 0 && authorization.mode === "interactive" && (action.risk === "R2" || action.risk === "R3")) return this.failureResult(operationId, action.id, action.risk, lastNotDispatched?.backend ?? candidate.backend, "ROUTE_REAUTHORIZATION_REQUIRED", "The prior backend did not dispatch. Interactive R2/R3 fallback requires previewing and approving a new exact-route plan.", false, "blocked");
        const confirmation = auth.code === "CONFIRMATION_REQUIRED";
        return this.failureResult(operationId, action.id, action.risk, candidate.backend, auth.code, auth.message, false, confirmation ? "confirmation_required" : "blocked");
      }
      try {
        await this.#ledger.record({
          operationId,
          actionId: action.id,
          backend: candidate.backend,
          risk: action.risk,
          status: "planned",
          timestamp: new Date().toISOString(),
          verificationOutcome: "pending",
          beforeRevision: request.expectedRevision ?? null,
          afterRevision: null,
        });
      } catch (error) {
        authorization.release(grant, "not_dispatched");
        return this.failureResult(operationId, action.id, action.risk, candidate.backend, "PRE_DISPATCH_RECORD_FAILED", `The operation ledger could not record the authorized plan before dispatch: ${(error as Error).message}`, true, "blocked");
      }

      let currentProbe: BackendProbe;
      try {
        currentProbe = await candidate.adapter.probe();
      } catch (error) {
        authorization.release(grant, "not_dispatched");
        lastNotDispatched = { backend: candidate.backend, response: { protocolVersion: 1, requestId: operationId, ok: false, dispatchState: "not_dispatched", error: { code: "BACKEND_REPROBE_FAILED", message: `Backend capability re-probe failed before dispatch: ${(error as Error).message}`, retryable: true } } };
        const reauthorization = this.fallbackReauthorizationResult(prepared, index, authorization, pendingFallback);
        if (reauthorization) return reauthorization;
        continue;
      }
      if (!currentProbe.available || !sameRouteBinding(routeBindingFromProbe(candidate.probe), routeBindingFromProbe(currentProbe))) {
        authorization.release(grant, "not_dispatched");
        lastNotDispatched = { backend: candidate.backend, response: { protocolVersion: 1, requestId: operationId, ok: false, dispatchState: "not_dispatched", error: { code: "ROUTE_BINDING_DRIFT", message: "Backend route binding changed before dispatch", retryable: true } } };
        const reauthorization = this.fallbackReauthorizationResult(prepared, index, authorization, pendingFallback);
        if (reauthorization) return reauthorization;
        continue;
      }

      if (!grant.checkpointRequired) {
        try {
          await authorization.revalidateForDispatch(grant);
        } catch (error) {
          authorization.release(grant, "not_dispatched");
          this.#pendingFallbacks.delete(operationId);
          const auth = error instanceof AuthorizationError ? error : new AuthorizationError("SESSION_LEASE_INVALID", (error as Error).message);
          return this.failureResult(operationId, action.id, action.risk, candidate.backend, auth.code, auth.message, false, "blocked");
        }
      }

      if (grant.checkpointRequired) {
        try {
          await createCheckpoint({
            dispatch: candidate.adapter,
            plan,
            approvedRoots: authorization.approvedRoots() ?? [],
            retention: grant.checkpointRetention,
          });
          await authorization.completeCheckpoint(grant);
          await authorization.revalidateForDispatch(grant);
        } catch (error) {
          const checkpoint = error instanceof CheckpointError ? error : new CheckpointError("CHECKPOINT_FAILED", (error as Error).message);
          this.#pendingFallbacks.delete(operationId);
          if (checkpoint.dispatchState === "unknown" || checkpoint.dispatchState === "accepted") {
            authorization.markCheckpointOutcomeUnknown(grant);
            const persistenceFailure = await this.recordDispatch(operationId, action.id, action.risk, candidate.backend, request.expectedRevision ?? null, undefined, "checkpoint");
            if (persistenceFailure) return persistenceFailure;
            const result = this.outcomeUnknownResult(operationId, action.id, action.risk, candidate.backend, checkpoint.message, "CHECKPOINT_OUTCOME_UNKNOWN", undefined, "checkpoint");
            return await this.record(result);
          }
          authorization.release(grant, "not_dispatched");
          if (checkpoint.dispatchState === "not_dispatched") {
            lastNotDispatched = { backend: candidate.backend, response: { protocolVersion: 1, requestId: operationId, ok: false, dispatchState: "not_dispatched", error: { code: checkpoint.code, message: checkpoint.message, retryable: true } } };
            const reauthorization = this.fallbackReauthorizationResult(prepared, index, authorization, pendingFallback);
            if (reauthorization) return reauthorization;
            continue;
          }
          const result = this.failureResult(operationId, action.id, action.risk, candidate.backend, checkpoint.code, checkpoint.message, false, "blocked");
          return await this.record(result);
        }
      }

      let recoverableOutput: RecoverableOutput | null = null;
      let dispatchArgs = request.args;
      if (action.id === "export.sequence" && request.args.overwrite === true && typeof request.args.outputPath === "string") {
        recoverableOutput = new RecoverableOutput(prepared.recoverableOutputPaths?.finalPath ?? request.args.outputPath, operationId);
        try {
          const temporaryPath = await recoverableOutput.begin();
          dispatchArgs = { ...request.args, outputPath: temporaryPath, overwrite: false };
        } catch (error) {
          authorization.release(grant, "not_dispatched");
          this.#pendingFallbacks.delete(operationId);
          if (error instanceof RecoverableOutputError && (error.code === "OUTPUT_RECOVERY_QUARANTINED" || error.code === "OUTPUT_RECOVERY_PREPARE_REQUIRES_RECONCILIATION")) {
            const result = this.outcomeUnknownResult(operationId, action.id, action.risk, candidate.backend, error.message, error.code, error.evidence, "local_recovery");
            return await this.record(result);
          }
          const result = this.failureResult(operationId, action.id, action.risk, candidate.backend, "OUTPUT_RECOVERY_PREPARE_FAILED", (error as Error).message, false, "blocked");
          return await this.record(result);
        }
      }

      try {
        await authorization.revalidateForDispatch(grant);
      } catch (error) {
        let recoveryError: Error | null = null;
        if (recoverableOutput) {
          try { await recoverableOutput.restoreKnownFailure(); }
          catch (restoreError) { recoveryError = restoreError as Error; }
        }
        authorization.release(grant, "not_dispatched");
        this.#pendingFallbacks.delete(operationId);
        if (recoveryError && recoverableOutput) {
          const result = this.outcomeUnknownResult(operationId, action.id, action.risk, candidate.backend, `Lease validation failed before dispatch and output restoration is unproven: ${recoveryError.message}`, "OUTPUT_RECONCILIATION_REQUIRED", recoverableOutput.reconciliationEvidence(), "local_recovery");
          return await this.record(result);
        }
        const auth = error instanceof AuthorizationError ? error : new AuthorizationError("SESSION_LEASE_INVALID", (error as Error).message);
        const result = this.failureResult(operationId, action.id, action.risk, candidate.backend, auth.code, auth.message, false, "blocked");
        return await this.record(result);
      }

      if (effectiveBridgeRequestDigest(action.id, dispatchArgs, request.expectedRevision) !== plan.effectiveRequestDigest) {
        let recoveryError: Error | null = null;
        if (recoverableOutput) {
          try { await recoverableOutput.restoreKnownFailure(); }
          catch (error) { recoveryError = error as Error; }
        }
        authorization.release(grant, "not_dispatched");
        this.#pendingFallbacks.delete(operationId);
        if (recoveryError && recoverableOutput) {
          const evidence = recoveryError instanceof RecoverableOutputError ? recoveryError.evidence : recoverableOutput.reconciliationEvidence();
          const result = this.outcomeUnknownResult(operationId, action.id, action.risk, candidate.backend, `Effective bridge request drifted and output restoration is unproven: ${recoveryError.message}`, "OUTPUT_RECONCILIATION_REQUIRED", evidence, "local_recovery");
          return await this.record(result);
        }
        const result = this.failureResult(operationId, action.id, action.risk, candidate.backend, "EFFECTIVE_REQUEST_DRIFT", "Effective bridge request drifted from the authorized execution plan", false, "blocked");
        return await this.record(result);
      }

      let response: BridgeResponse;
      try {
        response = await candidate.adapter.execute({
          protocolVersion: 1,
          requestId: operationId,
          operation: action.id,
          args: dispatchArgs,
          routeBinding: routeBindingFromProbe(candidate.probe),
          planHash: plan.planHash,
          effectiveRequestDigest: plan.effectiveRequestDigest,
          ...(request.expectedRevision ? { expectedRevision: request.expectedRevision } : {}),
        });
      } catch (error) {
        authorization.markDispatched(grant);
        this.#pendingFallbacks.delete(operationId);
        const evidence = recoverableOutput?.reconciliationEvidence();
        const persistenceFailure = await this.recordDispatch(operationId, action.id, action.risk, candidate.backend, request.expectedRevision ?? null, evidence);
        if (persistenceFailure) return persistenceFailure;
        const result = this.outcomeUnknownResult(operationId, action.id, action.risk, candidate.backend, (error as Error).message, "OUTCOME_UNKNOWN", evidence);
        return await this.record(result);
      }
      if (response.dispatchState === "not_dispatched") {
        if (recoverableOutput) {
          try { await recoverableOutput.restoreKnownFailure(); }
          catch (error) {
            authorization.release(grant, "not_dispatched");
            this.#pendingFallbacks.delete(operationId);
            const result = this.outcomeUnknownResult(operationId, action.id, action.risk, candidate.backend, `The host did not dispatch, but local output recovery failed: ${(error as Error).message}`, "OUTPUT_RECONCILIATION_REQUIRED", recoverableOutput.reconciliationEvidence(), "local_recovery");
            return await this.record(result);
          }
        }
        authorization.release(grant, "not_dispatched");
        lastNotDispatched = { backend: candidate.backend, response };
        const reauthorization = this.fallbackReauthorizationResult(prepared, index, authorization, pendingFallback);
        if (reauthorization) return reauthorization;
        continue;
      }
      authorization.markDispatched(grant);
      this.#pendingFallbacks.delete(operationId);
      const dispatchPersistenceFailure = await this.recordDispatch(operationId, action.id, action.risk, candidate.backend, request.expectedRevision ?? null, recoverableOutput?.reconciliationEvidence());
      if (dispatchPersistenceFailure) return dispatchPersistenceFailure;
      if (recoverableOutput && response.dispatchState === "completed") {
        if (!response.ok) {
          try { await recoverableOutput.restoreKnownFailure(); }
          catch (error) {
            const result = this.outcomeUnknownResult(operationId, action.id, action.risk, candidate.backend, `The export failed and its original output could not be restored: ${(error as Error).message}`, "OUTPUT_RECONCILIATION_REQUIRED", recoverableOutput.reconciliationEvidence(), "local_recovery");
            return await this.record(result);
          }
        } else {
          try {
            const snapshot = await recoverableOutput.complete();
            response = {
              ...response,
              createdFiles: [{ name: request.args.outputPath as string, verified: true }],
              verification: { outcome: "verified", method: `temporary export verified and atomically replaced (${snapshot.bytes} bytes, ${snapshot.sha256})` },
            };
          } catch (error) {
            if (error instanceof RecoverableOutputError) {
              const result = this.outcomeUnknownResult(operationId, action.id, action.risk, candidate.backend, error.message, error.code, error.evidence, error.code === "OUTPUT_RECOVERY_CLEANUP_FAILED" ? "output_commit" : "local_recovery");
              return await this.record(result);
            }
            try { await recoverableOutput.restoreKnownFailure(); }
            catch (recoveryError) {
              const recovery = recoveryError instanceof RecoverableOutputError ? recoveryError : null;
              const result = this.outcomeUnknownResult(operationId, action.id, action.risk, candidate.backend, `The temporary export could not be committed and restoration is unproven: ${(recoveryError as Error).message}`, "OUTPUT_RECONCILIATION_REQUIRED", recovery?.evidence, "local_recovery");
              return await this.record(result);
            }
            const result = this.failureResult(operationId, action.id, action.risk, candidate.backend, "OUTPUT_COMMIT_FAILED", `The temporary export could not be verified and atomically committed: ${(error as Error).message}`, false);
            return await this.record(result);
          }
        }
      }
      let result = this.resultFromResponse(operationId, action, request, candidate, response);
      if (recoverableOutput && response.dispatchState !== "completed") {
        const evidence = recoverableOutput.reconciliationEvidence();
        result = {
          ...result,
          data: evidence,
          reconciliation: {
            phase: "original_dispatch",
            errorCode: result.error?.code ?? "OUTCOME_UNKNOWN",
            recoveryEvidenceDigests: [sha256Canonical(evidence)],
            lockDigest: typeof evidence.lockDigest === "string" ? evidence.lockDigest : null,
          },
        };
      }
      return await this.record(result);
    }
    this.#pendingFallbacks.delete(operationId);
    const response = lastNotDispatched?.response;
    const result = this.failureResult(
      operationId,
      action.id,
      action.risk,
      lastNotDispatched?.backend ?? prepared.selected.backend,
      response?.error?.code ?? "NOT_DISPATCHED",
      response?.error?.message ?? "Every supported backend declined before dispatch",
      response?.error?.retryable ?? true,
      "failed",
    );
    return await this.record(result);
  }

  private async prepare(input: unknown, skippedBackends: readonly Backend[] = []): Promise<PreparedOperation> {
    let request = this.normalizeRequest(input);
    const action = getAction(request.actionId);
    this.assertAuthority(action.authority);
    request = { ...request, args: validateActionArgs(action, request.args), operationId: request.operationId ?? randomUUID() };
    if ((action.mutatesProject || (action.id === "export.sequence" && request.args.overwrite === true)) && (this.#localReconciliationRequired || (await this.#ledger.activeReconciliations()).length > 0)) {
      throw new AuthorizationError("RECONCILIATION_REQUIRED", "A prior unknown outcome must be explicitly reconciled before any further mutation or overwrite");
    }
    const adobeEntry = await validateAdobeRuntimeCall(action.id, request.args);
    const pathArguments = pathArgumentsForEntry(adobeEntry, request.args);
    await this.#pathPolicy.assert(action, pathArguments);
    await assertOutputPolicy(action.id, request.args);
    if (action.authority !== "filesystem" && Array.isArray(request.args.paths) && request.args.paths.length > 0) await this.#pathPolicy.assert({ ...action, authority: "filesystem" }, { paths: request.args.paths });
    const paths = collectPathValues(pathArguments);
    const approvedRootDigests = await this.#pathPolicy.approvedRootDigests();
    const unavailable: string[] = [];
    const candidates: PreparedOperation["candidates"] = [];
    const skipped = new Set(skippedBackends);
    const routingContext = { args: request.args, ...(request.target ? { target: request.target } : {}), ...(request.expectedRevision ? { expectedRevision: request.expectedRevision } : {}) };
    for (const backend of action.preferredBackends) {
      if (skipped.has(backend)) { unavailable.push(`${backend}: skipped after an explicit not_dispatched result`); continue; }
      const adapter = this.#adapters.get(backend);
      if (!adapter) { unavailable.push(`${backend}: adapter not configured`); continue; }
      try {
        const probe = await adapter.probe();
        if (!probe.available) { unavailable.push(`${backend}: ${probe.reason ?? "unavailable"}`); continue; }
        const support = await adapter.supports(action.id, routingContext);
        if (!support.supported) { unavailable.push(`${backend}: ${support.reason ?? `does not support ${action.id}`}`); continue; }
        candidates.push({ backend, adapter, probe });
      } catch (error) { unavailable.push(`${backend}: capability probe failed (${(error as Error).message})`); }
    }
    const selected = candidates[0];
    if (!selected) throw new Error(`NO_BACKEND_AVAILABLE: ${unavailable.join("; ")}`);
    const authorization = await this.#authorization;
    const requirements = await authorization.executionRequirements(action);
    const recoverablePaths = action.id === "export.sequence" && request.args.overwrite === true && typeof request.args.outputPath === "string"
      ? await canonicalRecoverableOutputPaths(request.args.outputPath, request.operationId!)
      : null;
    const plannedDispatchArgs = effectiveDispatchArgs(request.args, recoverablePaths);
    const plan = buildExecutionPlan({
      action, request, probe: selected.probe, approvedRootDigests,
      preconditions: executionPreconditions(recoverablePaths),
      checkpointRequired: requirements.checkpointRequired,
      effectiveArgs: plannedDispatchArgs,
    });
    return { request, action, paths, approvedRootDigests, candidates, selected, recoverableOutputPaths: recoverablePaths, effectiveDispatchArgs: plannedDispatchArgs, plan };
  }

  async status(operationId: string): Promise<Record<string, unknown>> {
    const record = await this.#ledger.get(operationId);
    return record ? { ...record } : { operationId, status: "not_found" };
  }

  private normalizeRequest(input: unknown): ActionRequest {
    return actionRequestSchema.parse(input);
  }

  private assertAuthority(authority: Authority): void {
    if (!this.#authorities.has(authority)) throw new Error(`Authority '${authority}' is disabled`);
  }

  private invalidRequestResult(input: unknown, error: Error): OperationResult {
    const actionId = typeof input === "object" && input && "actionId" in input && typeof (input as { actionId?: unknown }).actionId === "string"
      ? (input as { actionId: string }).actionId
      : "unknown";
    const parsed = actionRequestSchema.safeParse(input);
    const operationId = parsed.success ? parsed.data.operationId ?? randomUUID() : randomUUID();
    let risk: Risk = "R0";
    if (parsed.success) {
      try { risk = getAction(parsed.data.actionId).risk; } catch { /* The request rejection below remains authoritative. */ }
    }
    if (error instanceof AuthorizationError && (error.code === "CHECKPOINT_BARRIER_ACTIVE" || error.code === "RECONCILIATION_REQUIRED")) {
      return this.failureResult(operationId, actionId, risk, null, error.code, error.message, true, "blocked");
    }
    const noBackend = parsed.success && error.message.startsWith("NO_BACKEND_AVAILABLE:");
    return this.failureResult(operationId, actionId, risk, null, noBackend ? "NO_BACKEND_AVAILABLE" : parsed.success ? "REQUEST_REJECTED" : "INVALID_REQUEST", error.message, noBackend, noBackend ? "blocked" : "failed");
  }

  private pendingFallbackFor(input: unknown): PendingFallback | undefined {
    const parsed = actionRequestSchema.safeParse(input);
    return parsed.success && parsed.data.operationId ? this.#pendingFallbacks.get(parsed.data.operationId) : undefined;
  }

  private assertPendingFallbackRequest(prepared: PreparedOperation, pendingFallback: PendingFallback | undefined): void {
    if (pendingFallback && prepared.plan.normalizedRequestDigest !== pendingFallback.normalizedRequestDigest) throw new Error("Fallback reauthorization must use the exact same normalized request and operationId");
  }

  private fallbackReauthorizationResult(prepared: PreparedOperation, candidateIndex: number, authorization: AuthorizationService, pendingFallback: PendingFallback | undefined): OperationResult | null {
    if (authorization.mode !== "interactive" || (prepared.action.risk !== "R2" && prepared.action.risk !== "R3") || candidateIndex + 1 >= prepared.candidates.length) return null;
    const attemptedBackends = new Set(pendingFallback?.attemptedBackends ?? []);
    attemptedBackends.add(prepared.candidates[candidateIndex]!.backend);
    this.#pendingFallbacks.set(prepared.request.operationId!, {
      normalizedRequestDigest: prepared.plan.normalizedRequestDigest,
      attemptedBackends: [...attemptedBackends],
    });
    return this.failureResult(
      prepared.request.operationId!,
      prepared.action.id,
      prepared.action.risk,
      prepared.candidates[candidateIndex]!.backend,
      "ROUTE_REAUTHORIZATION_REQUIRED",
      "The prior backend did not dispatch. Preview the same operationId and exact request to approve the next supported route.",
      false,
      "blocked",
    );
  }

  private failureResult(operationId: string, actionId: string, risk: "R0" | "R1" | "R2" | "R3", backend: Backend | null, code: string, message: string, retryable: boolean, status: "failed" | "blocked" | "confirmation_required" = "failed"): OperationResult {
    return {
      operationId,
      actionId,
      status,
      backend,
      hostVersion: null,
      risk,
      beforeRevision: null,
      afterRevision: null,
      verification: { outcome: "failed", method: "none", detail: message },
      undo: { available: false, method: null },
      createdFiles: [],
      warnings: [],
      error: { code, message, retryable },
    };
  }

  private resultFromResponse(
    operationId: string,
    action: { id: string; risk: Risk; mutatesProject: boolean; undoable: boolean; verification: string },
    request: ActionRequest,
    candidate: { backend: Backend; probe: BackendProbe },
    response: BridgeResponse,
  ): OperationResult {
    if (!(["accepted", "completed", "unknown"] as const).includes(response.dispatchState as "accepted" | "completed" | "unknown")) {
      return this.outcomeUnknownResult(operationId, action.id, action.risk, candidate.backend, "Bridge response omitted a valid post-dispatch state");
    }
    if (response.dispatchState === "unknown") {
      return this.outcomeUnknownResult(operationId, action.id, action.risk, candidate.backend, response.error?.message ?? "The bridge could not determine whether the host accepted the operation");
    }
    if (response.dispatchState === "accepted") {
      return this.acceptedUnconfirmedResult(operationId, action.id, action.risk, candidate.backend, response.error?.message ?? "The host accepted the operation but completion was not confirmed");
    }
    if (!response.ok) {
      return this.failureResult(operationId, action.id, action.risk, candidate.backend, response.error?.code ?? "BRIDGE_ERROR", response.error?.message ?? "Bridge request failed", response.dispatchState === "completed" ? response.error?.retryable ?? false : false);
    }
    return {
      operationId,
      actionId: action.id,
      status: "succeeded",
      backend: candidate.backend,
      hostVersion: response.hostVersion ?? candidate.probe.hostVersion ?? null,
      risk: action.risk,
      beforeRevision: response.beforeRevision ?? request.expectedRevision ?? null,
      afterRevision: response.afterRevision ?? null,
      verification: response.verification ?? { outcome: action.mutatesProject ? "committed_unverified" : "not_applicable", method: action.verification },
      undo: { available: action.undoable, method: action.undoable ? "Premiere undo history" : null },
      createdFiles: response.createdFiles ?? [],
      warnings: response.verification?.outcome === "committed_unverified" ? ["Host accepted the operation, but its full postcondition was not verified."] : [],
      data: response.result,
    };
  }

  private acceptedUnconfirmedResult(operationId: string, actionId: string, risk: Risk, backend: Backend, detail: string): OperationResult {
    const result = this.outcomeUnknownResult(operationId, actionId, risk, backend, detail);
    return {
      ...result,
      warnings: ["The host accepted the operation, but completion was not confirmed. Inspect host state before any manual retry; never retry this operation automatically."],
      reconciliation: { ...(result.reconciliation!), errorCode: "OUTCOME_ACCEPTED" },
      error: { code: "OUTCOME_ACCEPTED", message: "The operation was accepted but completion was not confirmed. Inspect host state before retrying.", retryable: false },
    };
  }

  private async recordDispatch(operationId: string, actionId: string, risk: Risk, backend: Backend, beforeRevision: string | null, evidence?: unknown, phase: ReconciliationPhase = "original_dispatch"): Promise<OperationResult | null> {
    try {
      await this.#ledger.record({
        operationId,
        actionId,
        backend,
        risk,
        status: "dispatched",
        timestamp: new Date().toISOString(),
        verificationOutcome: "pending",
        beforeRevision,
        afterRevision: null,
      });
      return null;
    } catch {
      return this.persistLedgerFailure(this.ledgerPersistenceResult(operationId, actionId, risk, backend, evidence, phase));
    }
  }

  private outcomeUnknownResult(operationId: string, actionId: string, risk: "R0" | "R1" | "R2" | "R3", backend: Backend, detail: string, errorCode = "OUTCOME_UNKNOWN", evidence?: unknown, phase: ReconciliationPhase = "original_dispatch"): OperationResult {
    const evidenceDigest = evidence === undefined ? [] : [sha256Canonical(evidence)];
    const lockDigest = evidence && typeof evidence === "object" && "lockDigest" in evidence && typeof (evidence as { lockDigest?: unknown }).lockDigest === "string"
      ? (evidence as { lockDigest: string }).lockDigest
      : null;
    return {
      operationId,
      actionId,
      status: "reconciliation_required",
      backend,
      hostVersion: null,
      risk,
      beforeRevision: null,
      afterRevision: null,
      verification: { outcome: "committed_unverified", method: "bridge outcome unavailable after dispatch", detail },
      undo: { available: false, method: null },
      createdFiles: [],
      warnings: ["The host outcome is unknown. Inspect Premiere and output files before any manual retry; never retry this operation automatically."],
      reconciliation: { phase, errorCode, recoveryEvidenceDigests: evidenceDigest, lockDigest },
      ...(evidence === undefined ? {} : { data: evidence }),
      error: { code: errorCode, message: "The operation may have committed before the bridge failed. Inspect host state before retrying.", retryable: false },
    };
  }

  private async record(result: OperationResult): Promise<OperationResult> {
    try {
      await this.#ledger.record({
        operationId: result.operationId,
        actionId: result.actionId,
        backend: result.backend,
        risk: result.risk,
        status: result.status,
        timestamp: new Date().toISOString(),
        verificationOutcome: result.verification.outcome,
        beforeRevision: result.beforeRevision,
        afterRevision: result.afterRevision,
        ...(result.reconciliation ? { reconciliation: result.reconciliation } : {}),
      });
      return result;
    } catch {
      return this.persistLedgerFailure(this.ledgerPersistenceResult(result.operationId, result.actionId, result.risk, result.backend, result.data, result.reconciliation?.phase ?? "original_dispatch"));
    }
  }

  private ledgerPersistenceResult(operationId: string, actionId: string, risk: Risk, backend: Backend | null, evidence?: unknown, phase: ReconciliationPhase = "original_dispatch"): OperationResult {
    const evidenceDigest = evidence === undefined ? [] : [sha256Canonical(evidence)];
    const lockDigest = evidence && typeof evidence === "object" && "lockDigest" in evidence && typeof (evidence as { lockDigest?: unknown }).lockDigest === "string"
      ? (evidence as { lockDigest: string }).lockDigest
      : null;
    return {
      operationId, actionId, status: "reconciliation_required", backend, hostVersion: null, risk,
      beforeRevision: null, afterRevision: null,
      verification: { outcome: "committed_unverified", method: "durable operation ledger write failed", detail: "The pre-dispatch intent remains the authoritative quarantine until explicit reconciliation." },
      undo: { available: false, method: null }, createdFiles: [],
      warnings: ["Durable completion state could not be recorded. Stop mutations and reconcile the persisted planned/dispatched intent before continuing."],
      reconciliation: { phase, errorCode: "LEDGER_RECORD_FAILED", recoveryEvidenceDigests: evidenceDigest, lockDigest },
      ...(evidence === undefined ? {} : { data: evidence }),
      error: { code: "LEDGER_RECORD_FAILED", message: "Operation state could not be durably recorded; reconciliation is required.", retryable: false },
    };
  }

  private async persistLedgerFailure(result: OperationResult): Promise<OperationResult> {
    this.#localReconciliationRequired = true;
    try {
      await this.#ledger.record({
        operationId: result.operationId, actionId: result.actionId, backend: result.backend, risk: result.risk,
        status: result.status, timestamp: new Date().toISOString(), verificationOutcome: result.verification.outcome,
        beforeRevision: result.beforeRevision, afterRevision: result.afterRevision, reconciliation: result.reconciliation!,
      });
    } catch {
      // The already-persisted planned/dispatched intent becomes an orphaned
      // restart quarantine; this process also keeps the in-memory barrier.
    }
    return result;
  }
}
