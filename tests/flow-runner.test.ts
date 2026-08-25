import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { FlowRunner } from "../src/flows/flow-runner.js";
import type { OperationResult } from "../src/contracts.js";

function result(overrides: Partial<OperationResult> = {}): OperationResult {
  const id = randomUUID();
  return {
    operationId: id,
    actionId: overrides.actionId ?? "project.inspect",
    status: "succeeded",
    backend: "local",
    hostVersion: "test",
    risk: "R0",
    beforeRevision: null,
    afterRevision: "r2",
    verification: { outcome: "verified", method: "test" },
    undo: { available: false, method: null },
    createdFiles: [],
    warnings: [],
    ...overrides,
  };
}

function fakeEngine(handler: (request: { actionId: string; args: Record<string, unknown> }) => OperationResult) {
  return {
    execute: vi.fn(async (request: any) => handler(request)),
    status: vi.fn(async () => ({})),
  };
}

describe("FlowRunner watch & run", () => {
  it("executes every step in order with no approval references", async () => {
    const order: string[] = [];
    const engine = fakeEngine((request) => {
      order.push(request.actionId);
      return result({ actionId: request.actionId, afterRevision: `r${order.length + 1}` });
    });
    const runner = new FlowRunner(engine, {});
    const planned = await runner.plan({
      name: "watch-demo",
      steps: [
        { stepId: "s1", actionId: "timeline.clip.insert", args: {}, expectedRevision: "r1" },
        { stepId: "s2", actionId: "project.save", args: {} },
      ],
    });
    const done = await runner.run(planned.flowId);
    expect(done.status).toBe("succeeded");
    // A mutation flow always starts with an automatic checkpoint, then the
    // first real step. (A read to capture the current revision may appear
    // around the checkpoint; the invariant is that a real mutation is never
    // dispatched without a preceding checkpoint.)
    expect(order[0]).toBe("project.checkpoint");
    expect(order).toContain("timeline.clip.insert");
    expect(order).toContain("project.save");
    expect(order.indexOf("project.checkpoint")).toBeLessThan(order.indexOf("timeline.clip.insert"));
    // Never references approvalId/planHash confirmation.
    expect(JSON.stringify(engine.execute.mock.calls)).not.toContain("approvalId");
    expect(JSON.stringify(engine.execute.mock.calls)).not.toContain("planHash");
    expect(done.steps.map((step) => step.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("publishes queued/executing/committed events with before/after revisions", async () => {
    const engine = fakeEngine((request) => {
      if (request.actionId === "project.checkpoint") return result({ actionId: request.actionId, afterRevision: "ck" });
      return result({ actionId: request.actionId, beforeRevision: "before", afterRevision: "after" });
    });
    const runner = new FlowRunner(engine, {});
    const planned = await runner.plan({
      steps: [{ stepId: "s1", actionId: "timeline.clip.insert", args: {}, expectedRevision: "before" }],
      paceMs: 0,
    });
    await runner.run(planned.flowId);
    const { events } = await runner.progress();
    const phases = events.map((event) => event.phase);
    expect(phases).toContain("queued");
    expect(phases).toContain("executing");
    expect(phases).toContain("committed");
    const committed = events.find((event) => event.phase === "committed" && event.stepId === "s1");
    expect(committed).toMatchObject({ beforeRevision: "before", afterRevision: "after" });
  });

  it("stops before dispatch and reports stopped status when stop is requested", async () => {
    const engine = fakeEngine((request) => result({ actionId: request.actionId }));
    const runner = new FlowRunner(engine, {});
    const planned = await runner.plan({
      steps: [
        { stepId: "s1", actionId: "project.inspect", args: {} },
        { stepId: "s2", actionId: "media.import", args: {} },
      ],
      paceMs: 0,
    });
    await runner.stop(planned.flowId);
    const done = await runner.run(planned.flowId);
    expect(done.status).toBe("stopped");
    // project.checkpoint should not run because first mutation never started.
    expect(engine.execute.mock.calls.length).toBe(0);
  });

  it("automatically undoes a failed undoable mutating step and reports failure", async () => {
    let calls = 0;
    const engine = fakeEngine((request) => {
      calls += 1;
      if (request.actionId === "timeline.clip.insert") {
        return result({ actionId: request.actionId, status: "failed", error: { code: "IMPORT_FAILED", message: "boom", retryable: false } });
      }
      if (request.actionId === "history.undo") {
        return result({ actionId: request.actionId, afterRevision: "r0", undo: { available: true, method: "test" } });
      }
      return result({ actionId: request.actionId });
    });
    const runner = new FlowRunner(engine, {});
    const planned = await runner.plan({
      steps: [
        { stepId: "s1", actionId: "project.checkpoint", args: {} },
        { stepId: "s2", actionId: "timeline.clip.insert", args: {} },
      ],
      paceMs: 0,
    });
    const done = await runner.run(planned.flowId);
    expect(done.status).toBe("failed");
    expect(calls).toBeGreaterThanOrEqual(3);
    const { events } = await runner.progress();
    expect(events.some((event) => event.phase === "reverted")).toBe(true);
  });

  it("rejects a flow whose actionId is not in the trusted catalog", async () => {
    const runner = new FlowRunner(fakeEngine((request) => result({ actionId: request.actionId })), {});
    await expect(runner.plan({
      steps: [{ stepId: "bad", actionId: "does.not.exist", args: {} }],
    })).rejects.toThrow(/Unknown actionId/);
  });
});
