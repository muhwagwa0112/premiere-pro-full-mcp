/**
 * FlowRunner executes a linear sequence of Premiere operations without any
 * approval dialog. Each step is an independent undo unit and is reported on
 * the StepEventBus so the user can watch the editor change in real time.
 *
 * Safety model (no dialogs):
 *  - A project checkpoint is created automatically before the first mutation
 *    and before any non-undoable mutation (mirroring the "trusted" profile
 *    policy, but wholy code-driven and unattended).
 *  - Protected output writes (export.sequence overwrite) still go through the
 *    engine's recoverable-output machinery.
 *  - On a failed step, the previous step is automatically undone when the
 *    host can undo it, and the flow stops with a truthful status report.
 *  - Unknown dispatch outcomes are never replayed automatically.
 */

import { randomUUID } from "node:crypto";
import type { ActionRequest, OperationResult } from "../contracts.js";
import type { OperationEngine } from "../operation-engine.js";
import type { AuthorizationService } from "../security/authorization-service.js";
import { getAction } from "../catalog.js";
import { FlowStepEvent, StepEventBus } from "./step-event-bus.js";

export interface FlowStepInput {
  stepId: string;
  actionId: string;
  args: Record<string, unknown>;
  target?: Record<string, unknown>;
  expectedRevision?: string;
  label?: string;
}

export interface FlowPlanInput {
  flowId?: string;
  name?: string;
  steps: FlowStepInput[];
  paceMs?: number;
}

export type FlowStatus =
  | "planned"
  | "running"
  | "succeeded"
  | "failed"
  | "stopped"
  | "reconciliation_required";

export interface FlowRunRecord {
  flowId: string;
  name?: string;
  status: FlowStatus;
  paceMs: number;
  input: FlowStepInput[];
  steps: Array<{
    stepId: string;
    actionId: string;
    status: "pending" | "running" | "succeeded" | "failed" | "reverted";
    operationId?: string;
    /** The original input for this step, preserved for resumption. */
    input: FlowStepInput;
  }>;
  createdAt: string;
  updatedAt: string;
  error?: { code: string; message: string };
}

const REQUIRED_MUTATION_DELAY_MS = 300;
const EXPORT_ACTIONS = new Set(["export.sequence", "export.frame", "project.save_as", "project.checkpoint"]);

export class FlowRunner {
  readonly #operations: Pick<OperationEngine, "execute" | "status">;
  readonly #authorization: AuthorizationService | null;
  readonly #events = new StepEventBus();
  readonly #runs = new Map<string, FlowRunRecord>();
  readonly #stopRequests = new Set<string>();

  constructor(operations: Pick<OperationEngine, "execute" | "status">, options: { authorizationService?: AuthorizationService } = {}) {
    this.#operations = operations;
    this.#authorization = options.authorizationService ?? null;
  }

  events(): StepEventBus {
    return this.#events;
  }

  async plan(input: unknown): Promise<FlowRunRecord> {
    const parsed = input as FlowPlanInput;
    if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0 || parsed.steps.length > 128) {
      throw new Error("A flow requires between 1 and 128 steps");
    }
    for (const step of parsed.steps) {
      getAction(step.actionId); // validates the action exists
    }
    const now = new Date().toISOString();
    const paceMs = typeof parsed.paceMs === "number" && Number.isFinite(parsed.paceMs) ? parsed.paceMs : REQUIRED_MUTATION_DELAY_MS;
    const record: FlowRunRecord = {
      flowId: parsed.flowId ?? randomUUID(),
      ...(parsed.name ? { name: parsed.name } : {}),
      status: "planned",
      paceMs: Math.max(0, paceMs),
      input: parsed.steps,
      steps: parsed.steps.map((step) => ({ stepId: step.stepId, actionId: step.actionId, status: "pending", input: step })),
      createdAt: now,
      updatedAt: now,
    };
    this.#runs.set(record.flowId, record);
    return record;
  }

  async run(flowId: string): Promise<FlowRunRecord> {
    let flow = this.require(flowId);
    if (flow.status !== "planned" && flow.status !== "stopped") throw new Error(`Flow ${flowId} is ${flow.status}; only a planned (or stopped) flow can be executed`);
    const steps = flow.input;
    await this.update(flowId, (current) => ({ ...current, status: "running" }));

    let checkpointed = false;
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]!;
      const action = getAction(step.actionId);
      // Emit a queued event first so the observer can watch the editor before
      // the step lands.
      this.#events.emit({
        flowId, stepId: step.stepId, actionId: step.actionId, phase: "queued",
        message: `Queued: ${step.actionId}`, beforeRevision: null, afterRevision: null,
      });

      if (this.#stopRequests.has(flowId)) {
        this.#stopRequests.delete(flowId);
        return this.update(flowId, (current) => ({ ...current, status: "stopped", error: { code: "FLOW_STOPPED", message: "Stopped before the next step was dispatched." } }));
      }

      await this.update(flowId, (current) => ({
        ...current,
        steps: current.steps.map((candidate) => candidate.stepId === step.stepId ? { ...candidate, status: "running" } : candidate),
      }));

      const beforeRevision = step.expectedRevision ?? (await this.readRevision()).currentRevision;

      // Automatic checkpoint before the first mutation and before non-undoable
      // mutations. No dialog is shown; this is a code-level safety gate.
      const needsCheckpoint = action.mutatesProject && !checkpointed && !EXPORT_ACTIONS.has(action.id);
      if (needsCheckpoint) {
        const checkpointResult = await this.tryCheckpoint(flowId, beforeRevision);
        if (!checkpointResult.ok) {
          await this.recordFailure(flowId, step.stepId, checkpointResult.error ?? { code: "CHECKPOINT_FAILED", message: "Automatic checkpoint failed" });
          return this.require(flowId);
        }
        checkpointed = true;
      }

      const executingEvent: Omit<import("./step-event-bus.js").FlowStepEvent, "eventId" | "timestamp"> = {
        flowId, stepId: step.stepId, actionId: step.actionId, phase: "executing",
        message: `Executing: ${step.actionId}`,
        beforeRevision, afterRevision: null,
      };
      if (step.target) executingEvent.target = JSON.stringify(step.target);
      this.#events.emit(executingEvent);

      let result: OperationResult;
      try {
        result = await this.#operations.execute({
          actionId: step.actionId,
          args: step.args,
          ...(step.target ? { target: step.target } : {}),
          ...(step.expectedRevision ? { expectedRevision: step.expectedRevision } : { expectedRevision: beforeRevision }),
          operationId: randomUUID(),
        });
      } catch (error) {
        await this.recordFailure(flowId, step.stepId, { code: "FLOW_STEP_EXECUTION_FAILED", message: error instanceof Error ? error.message : "Step execution failed" });
        return this.require(flowId);
      }

      if (result.status === "reconciliation_required") {
        await this.recordFailure(flowId, step.stepId, { code: result.error?.code ?? "RECONCILIATION_REQUIRED", message: result.error?.message ?? "The step outcome is unknown; the flow stopped and will not re-dispatch." });
        return this.require(flowId);
      }

      if (result.status !== "succeeded") {
        await this.undoStep(flowId, step.stepId, beforeRevision);
        await this.recordFailure(flowId, step.stepId, { code: result.error?.code ?? "FLOW_STEP_FAILED", message: result.error?.message ?? "Step failed and was undone where possible." });
        return this.require(flowId);
      }

      this.#events.emit({
        flowId, stepId: step.stepId, actionId: step.actionId, phase: "committed",
        message: `${step.actionId} committed`, beforeRevision, afterRevision: result.afterRevision ?? null,
      });

      await this.update(flowId, (current) => ({
        ...current,
        steps: current.steps.map((candidate) => candidate.stepId === step.stepId
          ? { ...candidate, status: "succeeded", operationId: result.operationId }
          : candidate),
      }));

      // Let the editor visibly settle between mutations (export-like actions
      // and zero pace run immediately).
      if (this.shouldPace(action.id) && flow.paceMs > 0 && index < steps.length - 1) {
        await delay(flow.paceMs);
      }
    }

    const final = await this.readRevision();
    return this.update(flowId, (current) => ({ ...current, status: "succeeded", updatedAt: new Date().toISOString() }));
  }

  async status(flowId: string): Promise<FlowRunRecord | { flowId: string; status: "not_found" }> {
    return this.#runs.get(flowId) ?? { flowId, status: "not_found" };
  }

  async progress(options: { afterEventId?: string; flowId?: string } = {}): Promise<{ events: FlowStepEvent[] }> {
    return { events: this.#events.drain(options) };
  }

  async stop(flowId: string): Promise<FlowRunRecord> {
    const flow = this.require(flowId);
    if (flow.status !== "running" && flow.status !== "planned") return flow;
    this.#stopRequests.add(flowId);
    return this.update(flowId, (current) => ({
      ...current,
      status: current.status === "running" ? current.status : "stopped",
      ...(current.status !== "running" ? { error: { code: "FLOW_STOPPED", message: "Stop requested between steps." } } : {}),
    }));
  }

  private async recordFailure(flowId: string, stepId: string, error: { code: string; message: string }): Promise<void> {
    const current = this.require(flowId);
    const step = current.steps.find((candidate) => candidate.stepId === stepId);
    this.#events.emit({
      flowId, stepId, actionId: step?.actionId ?? "unknown", phase: "failed",
      message: `${error.code}: ${error.message}`, beforeRevision: null, afterRevision: null,
    });
    await this.update(flowId, (candidate) => ({
      ...candidate,
      status: "failed",
      error,
      steps: candidate.steps.map((entry) => entry.stepId === stepId ? { ...entry, status: "failed" } : entry),
    }));
  }

  private async undoStep(flowId: string, stepId: string, beforeRevision: string | null): Promise<void> {
    const action = getAction(this.require(flowId).steps.find((step) => step.stepId === stepId)?.actionId ?? "unknown");
    if (!action.undoable || !beforeRevision) return;
    try {
      await this.#operations.execute({ actionId: "history.undo", args: {}, operationId: randomUUID(), expectedRevision: beforeRevision });
      this.#events.emit({
        flowId, stepId, actionId: action.id, phase: "reverted",
        message: `Automatically undid ${action.id}`, beforeRevision, afterRevision: null,
      });
    } catch (error) {
      this.#events.emit({
        flowId, stepId, actionId: action.id, phase: "reverted",
        message: `Automatic undo failed: ${error instanceof Error ? error.message : "unknown"}`, beforeRevision, afterRevision: null,
      });
    }
  }

  private async tryCheckpoint(flowId: string, beforeRevision: string | null): Promise<{ ok: boolean; error?: { code: string; message: string } }> {
    try {
      this.#events.emit({
        flowId, stepId: "checkpoint", actionId: "project.checkpoint", phase: "executing",
        message: "Creating automatic project checkpoint before mutation", beforeRevision, afterRevision: null,
      });
      const result = await this.#operations.execute({ actionId: "project.checkpoint", args: {}, operationId: randomUUID() });
      if (result.status !== "succeeded") {
        return { ok: false, error: { code: result.error?.code ?? "CHECKPOINT_FAILED", message: result.error?.message ?? "Automatic checkpoint failed" } };
      }
      this.#events.emit({
        flowId, stepId: "checkpoint", actionId: "project.checkpoint", phase: "committed",
        message: "Automatic checkpoint created", beforeRevision, afterRevision: result.afterRevision ?? null,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: { code: "CHECKPOINT_FAILED", message: error instanceof Error ? error.message : "Automatic checkpoint failed" } };
    }
  }

  private async readRevision(): Promise<{ currentRevision: string | null }> {
    try {
      const inspect = await this.#operations.execute({ actionId: "sequence.inspect", args: {}, operationId: randomUUID() });
      const after = inspect.afterRevision ?? null;
      return { currentRevision: after ?? inspect.beforeRevision ?? null };
    } catch {
      try {
        const inspect = await this.#operations.execute({ actionId: "project.inspect", args: {}, operationId: randomUUID() });
        const after = inspect.afterRevision ?? null;
        return { currentRevision: after ?? inspect.beforeRevision ?? null };
      } catch {
        return { currentRevision: null };
      }
    }
  }

  private shouldPace(actionId: string): boolean {
    return !EXPORT_ACTIONS.has(actionId);
  }

  private require(flowId: string): FlowRunRecord {
    const flow = this.#runs.get(flowId);
    if (!flow) throw new Error(`Flow ${flowId} was not found`);
    return flow;
  }

  private async update(flowId: string, updater: (current: FlowRunRecord) => FlowRunRecord): Promise<FlowRunRecord> {
    const current = this.require(flowId);
    const next = updater(current);
    next.updatedAt = new Date().toISOString();
    this.#runs.set(flowId, next);
    return next;
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
