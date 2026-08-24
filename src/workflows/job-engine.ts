import { randomUUID } from "node:crypto";
import { getAction, validateActionArgs } from "../catalog.js";
import type { ActionRequest, OperationResult } from "../contracts.js";
import type { OperationEngine } from "../operation-engine.js";
import { jobPlanInputSchema, type JobPlanInput, type JobRecord, type JobStepEvidence, type JobStepRecord } from "./job-contracts.js";
import { JobStore, type JobStoreProtector } from "./job-store.js";

function topologicalOrder(steps: readonly { stepId: string; dependsOn: readonly string[] }[]): string[] {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  if (byId.size !== steps.length) throw new Error("Job stepId values must be unique");
  const indegree = new Map(steps.map((step) => [step.stepId, 0]));
  const dependents = new Map(steps.map((step) => [step.stepId, [] as string[]]));
  for (const step of steps) {
    const dependencies = new Set(step.dependsOn);
    if (dependencies.size !== step.dependsOn.length) throw new Error(`Step ${step.stepId} has duplicate dependencies`);
    if (dependencies.has(step.stepId)) throw new Error(`Step ${step.stepId} cannot depend on itself`);
    for (const dependency of dependencies) {
      if (!byId.has(dependency)) throw new Error(`Step ${step.stepId} depends on unknown step ${dependency}`);
      indegree.set(step.stepId, (indegree.get(step.stepId) ?? 0) + 1);
      dependents.get(dependency)!.push(step.stepId);
    }
  }
  const ready = steps.filter((step) => indegree.get(step.stepId) === 0).map((step) => step.stepId);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const stepId = ready.shift()!;
    ordered.push(stepId);
    for (const dependent of dependents.get(stepId) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }
  if (ordered.length !== steps.length) throw new Error("Job dependency graph contains a cycle");
  return ordered;
}

function requestWithOperationId(request: ActionRequest): ActionRequest {
  return { ...request, operationId: request.operationId ?? randomUUID() };
}

function containsSemanticHandle(value: unknown, depth = 0): boolean {
  if (depth > 12 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsSemanticHandle(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string" && typeof record.session === "string" && typeof record.stateToken === "string") return true;
  return Object.values(record).some((item) => containsSemanticHandle(item, depth + 1));
}

function stepEvidence(result: OperationResult): JobStepEvidence {
  return {
    operationId: result.operationId,
    verificationOutcome: result.verification.outcome,
    verificationMethod: result.verification.method,
    verifiedCompleted: result.status === "succeeded" && (result.verification.outcome === "verified" || result.verification.outcome === "not_applicable"),
    undoAvailable: result.undo.available,
    beforeRevision: result.beforeRevision,
    afterRevision: result.afterRevision,
  };
}

function withTimestamp(record: JobRecord): JobRecord {
  return { ...record, updatedAt: new Date().toISOString() };
}

export class JobEngine {
  readonly #operations: Pick<OperationEngine, "execute">;
  readonly #store: JobStore;
  readonly #running = new Set<string>();

  constructor(operations: Pick<OperationEngine, "execute">, options: { store?: JobStore; directory?: string; protector?: JobStoreProtector } = {}) {
    this.#operations = operations;
    this.#store = options.store ?? new JobStore(options.directory, options.protector);
  }

  async plan(input: unknown): Promise<JobRecord> {
    const parsed: JobPlanInput = jobPlanInputSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > 512 * 1024) throw new Error("Job plan exceeds the 512 KiB input limit");
    topologicalOrder(parsed.steps);
    const now = new Date().toISOString();
    const operationIds = new Set<string>();
    const steps: JobStepRecord[] = parsed.steps.map((step) => {
      const requestAction = getAction(step.request.actionId);
      const request = requestWithOperationId({ ...step.request, args: validateActionArgs(requestAction, step.request.args) });
      const rollbackRequest = step.rollbackRequest ? (() => {
        const rollbackAction = getAction(step.rollbackRequest.actionId);
        return requestWithOperationId({ ...step.rollbackRequest, args: validateActionArgs(rollbackAction, step.rollbackRequest.args) });
      })() : undefined;
      if (step.dependsOn.length > 0 && requestAction.stateTokenRequired && containsSemanticHandle(request.args)) {
        throw new Error(`Step ${step.stepId} requires a refreshed semantic handle after its dependency; durable jobs do not guess or reuse stale UXP handle state tokens`);
      }
      if (rollbackRequest && containsSemanticHandle(rollbackRequest.args)) {
        throw new Error(`Rollback for step ${step.stepId} cannot persist a semantic handle that will be stale after forward execution`);
      }
      for (const operationId of [request.operationId, rollbackRequest?.operationId]) {
        if (!operationId) continue;
        if (operationIds.has(operationId)) throw new Error(`operationId ${operationId} is reused within the job`);
        operationIds.add(operationId);
      }
      return {
        stepId: step.stepId,
        request,
        dependsOn: [...step.dependsOn],
        ...(rollbackRequest ? { rollbackRequest } : {}),
        status: "pending",
        attempts: 0,
      };
    });
    const record: JobRecord = {
      schemaVersion: 1,
      jobId: parsed.jobId ?? randomUUID(),
      ...(parsed.name ? { name: parsed.name } : {}),
      status: "planned",
      cancellation: { requested: false, boundary: "before_step_dispatch", requestedAt: null },
      createdAt: now,
      updatedAt: now,
      steps,
    };
    await this.#store.create(record);
    return record;
  }

  async status(jobId: string): Promise<JobRecord | { jobId: string; status: "not_found" }> {
    return await this.#store.get(jobId) ?? { jobId, status: "not_found" };
  }

  async execute(jobId: string): Promise<JobRecord> {
    const job = await this.require(jobId);
    if (job.status !== "planned") return this.withError(job, "JOB_NOT_PLANNED", "Only a planned job can be executed. Use resume for a failed or cancelled job.");
    return this.run(jobId, false);
  }

  async resume(jobId: string): Promise<JobRecord> {
    const job = await this.require(jobId);
    if (job.status === "reconciliation_required" || job.steps.some((step) => step.status === "reconciliation_required")) {
      return this.withError(job, "JOB_RECONCILIATION_REQUIRED", "A step has an unknown dispatch outcome. Resume is blocked until external reconciliation supplies trustworthy evidence.");
    }
    if (!["failed", "cancelled"].includes(job.status)) return this.withError(job, "JOB_NOT_RESUMABLE", `Job status ${job.status} is not resumable`);
    await this.#store.update(jobId, (current) => {
      const { error: _error, ...withoutError } = current;
      return withTimestamp({
      ...withoutError,
      status: "planned",
      cancellation: { requested: false, boundary: "before_step_dispatch", requestedAt: null },
      steps: current.steps.map((step) => {
        if (step.status === "succeeded" && step.evidence?.verifiedCompleted) return step;
        if (step.status === "rolled_back") return step;
        const { approvalId: _approvalId, planHash: _planHash, ...requestWithoutApproval } = step.request;
        const { result: _result, evidence: _evidence, ...stepWithoutResult } = step;
        const request: ActionRequest = { ...requestWithoutApproval, operationId: randomUUID() };
        return { ...stepWithoutResult, request, status: "pending" };
      }),
    });
    });
    return this.run(jobId, true);
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const existing = await this.require(jobId);
    if (!["planned", "running", "cancel_pending"].includes(existing.status)) {
      return ["cancelled"].includes(existing.status)
        ? existing
        : this.withError(existing, "CANCEL_NOT_AVAILABLE", `Job status ${existing.status} has no cancellable pre-dispatch boundary`);
    }
    return this.#store.update(jobId, (current) => {
      if (!["planned", "running", "cancel_pending"].includes(current.status)) {
        return null;
      }
      const requestedAt = new Date().toISOString();
      const inFlight = current.steps.some((step) => step.status === "running");
      return withTimestamp({
        ...current,
        status: inFlight ? "cancel_pending" : "cancelled",
        cancellation: { requested: true, boundary: "before_step_dispatch", requestedAt },
        error: { code: "CANCEL_BOUNDARY", message: inFlight ? "Cancellation will take effect before the next step dispatch; the in-flight host call cannot be interrupted." : "Cancellation took effect before the next step dispatch." },
      });
    });
  }

  async rollback(jobId: string): Promise<JobRecord> {
    if (this.#running.has(jobId)) return this.withError(await this.require(jobId), "JOB_ALREADY_RUNNING", "The job is already executing");
    const initial = await this.require(jobId);
    if (!["succeeded", "failed", "cancelled"].includes(initial.status)) return this.withError(initial, "ROLLBACK_NOT_AVAILABLE", `Job status ${initial.status} cannot be rolled back`);
    const order = topologicalOrder(initial.steps).reverse();
    const targets = order.map((stepId) => initial.steps.find((step) => step.stepId === stepId)!).filter((step) => step.status === "succeeded" && getAction(step.request.actionId).mutatesProject);
    for (const step of targets) {
      if (!step.evidence?.verifiedCompleted || !step.evidence.undoAvailable || !step.evidence.afterRevision || !step.rollbackRequest) {
        return this.withError(initial, "ROLLBACK_EVIDENCE_INSUFFICIENT", `Step ${step.stepId} lacks verified completion, a post-step revision, host undo evidence, or an explicit rollback request`);
      }
    }
    this.#running.add(jobId);
    try {
      await this.#store.update(jobId, (current) => {
        const { error: _error, ...withoutError } = current;
        return withTimestamp({ ...withoutError, status: "rolling_back" });
      });
      let expectedRevision = targets[0]?.evidence?.afterRevision ?? null;
      for (const planned of targets) {
        const claimed = await this.#store.update(jobId, (current) => {
          const step = current.steps.find((candidate) => candidate.stepId === planned.stepId)!;
          step.status = "running";
          return withTimestamp(current);
        });
        const step = claimed.steps.find((candidate) => candidate.stepId === planned.stepId)!;
        if (!expectedRevision || (step.rollbackRequest!.expectedRevision && step.rollbackRequest!.expectedRevision !== expectedRevision)) {
          return this.#store.update(jobId, (current) => withTimestamp({ ...current, status: "rollback_failed", error: { code: "ROLLBACK_REVISION_DRIFT", message: `Rollback request for ${planned.stepId} is not bound to the latest verified revision` } }));
        }
        const result = await this.#operations.execute({ ...step.rollbackRequest!, expectedRevision });
        const verified = stepEvidence(result).verifiedCompleted && result.beforeRevision === expectedRevision && result.afterRevision !== null;
        const updated = await this.#store.update(jobId, (current) => {
          const currentStep = current.steps.find((candidate) => candidate.stepId === planned.stepId)!;
          currentStep.rollbackResult = result;
          currentStep.status = verified ? "rolled_back" : result.status === "reconciliation_required" ? "reconciliation_required" : "rollback_failed";
          return withTimestamp({
            ...current,
            status: verified ? "rolling_back" : result.status === "reconciliation_required" ? "reconciliation_required" : "rollback_failed",
            ...(!verified ? { error: { code: result.error?.code ?? "ROLLBACK_FAILED", message: result.error?.message ?? `Rollback of ${planned.stepId} was not verified` } } : {}),
          });
        });
        if (!verified) return updated;
        expectedRevision = result.afterRevision;
      }
      return this.#store.update(jobId, (current) => {
        const { error: _error, ...withoutError } = current;
        return withTimestamp({ ...withoutError, status: "rolled_back" });
      });
    } finally {
      this.#running.delete(jobId);
    }
  }

  private async run(jobId: string, _resume: boolean): Promise<JobRecord> {
    if (this.#running.has(jobId)) return this.withError(await this.require(jobId), "JOB_ALREADY_RUNNING", "The job is already executing");
    this.#running.add(jobId);
    try {
      const order = topologicalOrder((await this.require(jobId)).steps);
      await this.#store.update(jobId, (current) => {
        const { error: _error, ...withoutError } = current;
        return withTimestamp({ ...withoutError, status: "running" });
      });
      for (const stepId of order) {
        const before = await this.require(jobId);
        const existing = before.steps.find((step) => step.stepId === stepId)!;
        if (existing.status === "succeeded") {
          if (existing.evidence?.verifiedCompleted) continue;
          return this.#store.update(jobId, (current) => withTimestamp({ ...current, status: "reconciliation_required", error: { code: "UNVERIFIED_COMPLETED_STEP", message: `Step ${stepId} completed without sufficient verification and cannot be skipped or replayed` } }));
        }
        const dependencies = existing.dependsOn.map((dependency) => before.steps.find((step) => step.stepId === dependency)!);
        if (dependencies.some((dependency) => dependency.status !== "succeeded" || !dependency.evidence?.verifiedCompleted)) {
          return this.#store.update(jobId, (current) => withTimestamp({ ...current, status: "failed", error: { code: "DEPENDENCY_NOT_VERIFIED", message: `Step ${stepId} has a dependency that is not verified complete` } }));
        }
        if (getAction(existing.request.actionId).stateTokenRequired && dependencies.length > 0) {
          const revisions = new Set(dependencies.map((dependency) => dependency.evidence?.afterRevision).filter((revision): revision is string => typeof revision === "string" && revision.length > 0));
          if (revisions.size !== 1) {
            return this.#store.update(jobId, (current) => withTimestamp({ ...current, status: "failed", error: { code: "DEPENDENCY_STATE_TOKEN_AMBIGUOUS", message: `Step ${stepId} cannot bind one exact expectedRevision from its verified dependencies` } }));
          }
          const expectedRevision = [...revisions][0]!;
          await this.#store.update(jobId, (current) => {
            const step = current.steps.find((candidate) => candidate.stepId === stepId)!;
            const { approvalId: _approvalId, planHash: _planHash, ...unapprovedRequest } = step.request;
            step.request = { ...unapprovedRequest, expectedRevision };
            return withTimestamp(current);
          });
        }
        const claimed = await this.#store.update(jobId, (current) => {
          if (current.cancellation.requested) return withTimestamp({ ...current, status: "cancelled", error: { code: "CANCEL_BOUNDARY", message: "Cancellation took effect before the next step dispatch." } });
          const step = current.steps.find((candidate) => candidate.stepId === stepId)!;
          step.status = "running";
          step.attempts += 1;
          return withTimestamp({ ...current, status: "running" });
        });
        const step = claimed.steps.find((candidate) => candidate.stepId === stepId)!;
        if (claimed.status === "cancelled" || step.status !== "running") return claimed;
        const result = await this.#operations.execute(step.request);
        const evidence = stepEvidence(result);
        const updated = await this.#store.update(jobId, (current) => {
          const currentStep = current.steps.find((candidate) => candidate.stepId === stepId)!;
          currentStep.result = result;
          currentStep.evidence = evidence;
          if (result.status === "reconciliation_required" || (result.status === "succeeded" && !evidence.verifiedCompleted)) {
            currentStep.status = "reconciliation_required";
            return withTimestamp({ ...current, status: "reconciliation_required", error: { code: result.error?.code ?? "STEP_OUTCOME_UNVERIFIED", message: result.error?.message ?? `Step ${stepId} did not produce verified completion evidence` } });
          }
          if (result.status !== "succeeded") {
            currentStep.status = "failed";
            return withTimestamp({ ...current, status: "failed", error: { code: result.error?.code ?? "STEP_FAILED", message: result.error?.message ?? `Step ${stepId} failed` } });
          }
          currentStep.status = "succeeded";
          if (current.cancellation.requested) return withTimestamp({ ...current, status: "cancelled", error: { code: "CANCEL_BOUNDARY", message: "The in-flight step completed; cancellation took effect before the next step dispatch." } });
          return withTimestamp(current);
        });
        if (updated.status !== "running") return updated;
      }
      return this.#store.update(jobId, (current) => {
        if (current.cancellation.requested) return withTimestamp({ ...current, status: "cancelled", error: { code: "CANCEL_BOUNDARY", message: "Cancellation took effect before the next step dispatch." } });
        const { error: _error, ...withoutError } = current;
        return withTimestamp({ ...withoutError, status: "succeeded" });
      });
    } finally {
      this.#running.delete(jobId);
    }
  }

  private async require(jobId: string): Promise<JobRecord> {
    const job = await this.#store.get(jobId);
    if (!job) throw new Error(`Job ${jobId} was not found`);
    return job;
  }

  private withError(job: JobRecord, code: string, message: string): JobRecord {
    return withTimestamp({ ...job, error: { code, message } });
  }
}

export type { JobRecord } from "./job-contracts.js";
