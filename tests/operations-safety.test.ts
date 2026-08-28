import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_TOOL_NAMES } from "../src/tool-names.js";
import { OperationCoordinator } from "../src/operations/coordinator.js";
import { OperationLedger, payloadMetadata } from "../src/operations/ledger.js";
import { TOOL_POLICIES, ToolPolicyError, assertRawExtendScriptReadOnly, assertToolWithinPolicy, assertTransportWithinPolicy, getToolPolicy } from "../src/operations/tool-policy.js";
import { MutationQuarantinedError, OperationExecutionUnknownError, OperationIdReusedError, type OperationSnapshot } from "../src/operations/types.js";
import { buildToolScript } from "../vendor/upstream/bridge/script-builder.js";
import { wrapCepEvalScript } from "../src/bridge/cep-script.js";

async function tempLedger(): Promise<OperationLedger> {
  return new OperationLedger(await mkdtemp(join(tmpdir(), "premiere-operations-")));
}
function snapshot(fingerprint: string): OperationSnapshot {
  return { projectionVersion: 2, fingerprint, capturedAt: "2026-08-27T00:00:00.000Z" };
}

describe("operation tool policy", () => {
  it("assigns exactly one fail-closed policy to every unchanged catalog name", () => {
    expect(Object.keys(TOOL_POLICIES)).toHaveLength(ALL_TOOL_NAMES.length);
    for (const name of ALL_TOOL_NAMES) {
      expect(getToolPolicy(name)).toBe(getToolPolicy(`premiere_${name}`));
    }
    expect(() => getToolPolicy("premiere_future_unclassified_tool")).toThrow(/No operation-safety policy/);
  });

  it("rejects raw scripts that combine placement, keyframes, or save", () => {
    const policy = getToolPolicy("execute_extendscript");
    const mixed = "seq.overwriteClip(item, 0); prop.addKey(t);";
    expect(() => assertToolWithinPolicy("premiere_execute_extendscript", {
      script: mixed, scriptBytes: Buffer.byteLength(mixed), argsBytes: 2, itemCount: 1,
      executionTimeoutMs: policy.maxExecutionTimeoutMs, queueDeadlineMs: policy.maxQueueDeadlineMs,
    })).toThrow(ToolPolicyError);
    const saveMixed = "prop.setValue(1); app.project.save();";
    expect(() => assertToolWithinPolicy("execute_extendscript", {
      script: saveMixed, scriptBytes: Buffer.byteLength(saveMixed), argsBytes: 2, itemCount: 1,
      executionTimeoutMs: policy.maxExecutionTimeoutMs, queueDeadlineMs: policy.maxQueueDeadlineMs,
    })).toThrow(/mixed operation classes/);
  });

  it("allows one raw placement call with the requested 120 second budget", () => {
    const script = "seq.overwriteClip(item, 0);";
    expect(assertToolWithinPolicy("execute_extendscript", {
      script, scriptBytes: Buffer.byteLength(script), argsBytes: 2, itemCount: 1,
      executionTimeoutMs: 120_000, queueDeadlineMs: 30_000,
    }).maxExecutionTimeoutMs).toBe(120_000);
  });

  it("allows the documented long-running XML import and frame-export budgets", () => {
    expect(getToolPolicy("import_fcp_xml")).toMatchObject({ maxExecutionTimeoutMs: 300_000, maxQueueDeadlineMs: 120_000 });
    expect(getToolPolicy("export_frame")).toMatchObject({ maxExecutionTimeoutMs: 120_000, maxQueueDeadlineMs: 120_000 });
  });

  it("allows one bounded compound keyframe operation but not placement/save mixes", () => {
    const script = "prop.addKey(t); prop.setValueAtKey(1, 0.5); prop.setInterpolationTypeAtKey(1, 5, 5);";
    expect(() => assertToolWithinPolicy("execute_extendscript", {
      script, scriptBytes: Buffer.byteLength(script), argsBytes: 2, itemCount: 1,
      executionTimeoutMs: 120_000, queueDeadlineMs: 30_000,
    })).not.toThrow();
  });

  it("provides an opt-in conservative raw read-only validator", () => {
    expect(() => assertRawExtendScriptReadOnly("execute_extendscript", "return app.project.name;")).not.toThrow();
    expect(() => assertRawExtendScriptReadOnly("execute_extendscript", "app.project.save();")).toThrow(ToolPolicyError);
    expect(() => assertRawExtendScriptReadOnly("execute_extendscript", "eval(payload);")).toThrow(ToolPolicyError);
    expect(() => assertRawExtendScriptReadOnly("execute_extendscript", "app.project.name = 'changed';")).toThrow(ToolPolicyError);
    expect(() => assertRawExtendScriptReadOnly("execute_extendscript", "app.project.openSequence('1');")).toThrow(ToolPolicyError);
  });

  it("separates the 16 KiB caller-source limit from the 64 KiB generated transport limit", () => {
    const source = `var note = "${"x".repeat(15_000)}"; return __result({ok:true});`;
    const generated = `${"function helper(){ return true; }\n".repeat(150)}${source}`;
    expect(assertToolWithinPolicy("execute_extendscript", {
      script: source, scriptBytes: Buffer.byteLength(source), argsBytes: Buffer.byteLength(JSON.stringify({ code: source })), itemCount: 1,
      executionTimeoutMs: 120_000, queueDeadlineMs: 30_000,
    }).maxScriptBytes).toBe(16 * 1024);
    expect(assertTransportWithinPolicy("execute_extendscript", {
      script: generated, scriptBytes: Buffer.byteLength(generated), argsBytes: 2, itemCount: 1,
      executionTimeoutMs: 120_000, queueDeadlineMs: 30_000,
    }).maxTransportScriptBytes).toBe(64 * 1024);
  });
});

describe("operation ledger", () => {
  it("stores hashes and metadata without argument, script, target, or result bodies", async () => {
    const ledger = await tempLedger();
    await ledger.append({
      schemaVersion: 1, operationId: "op-1", recordedAt: "2026-08-27T00:00:00.000Z", toolName: "add_marker",
      backend: "cep", mode: "mutate", status: "SUCCEEDED", args: payloadMetadata({ secret: "ARG_BODY" }),
      script: payloadMetadata("SCRIPT_BODY"), target: { kind: "sequence", sha256: "a".repeat(64) },
    });
    const raw = await readFile(ledger.path, "utf8");
    expect(raw).not.toContain("ARG_BODY");
    expect(raw).not.toContain("SCRIPT_BODY");
    expect(raw).not.toContain("result");
    expect(await ledger.readEntries()).toHaveLength(1);
  });

  it("tolerates only a truncated final JSONL line", async () => {
    const ledger = await tempLedger();
    const valid = { schemaVersion: 1, operationId: "op", recordedAt: "now", toolName: "ping", backend: "cep", mode: "read", status: "SUCCEEDED" };
    await writeFile(ledger.path, `${JSON.stringify(valid)}\n{"schemaVersion":`, "utf8");
    expect(await ledger.readEntries()).toHaveLength(1);
    await ledger.append({ ...valid, operationId: "after-recovery" } as never);
    expect(await ledger.readEntries()).toHaveLength(2);
    expect(await readFile(ledger.path, "utf8")).not.toContain('{"schemaVersion":\n');
    await writeFile(ledger.path, `${JSON.stringify(valid)}\nnot-json\n`, "utf8");
    await expect(ledger.readEntries()).rejects.toThrow(/Corrupt operation ledger line 2/);
  });
});

describe("operation coordinator", () => {
  it("promotes crash-left mutation QUEUED/RUNNING records to durable UNKNOWN on restart", async () => {
    const ledger = await tempLedger();
    await ledger.append({ schemaVersion: 1, operationId: "crash-queued", recordedAt: "2026-08-28T00:00:00.000Z", toolName: "add_marker", backend: "cep", mode: "mutate", status: "QUEUED" });
    await ledger.append({ schemaVersion: 1, operationId: "crash-running", recordedAt: "2026-08-28T00:00:00.000Z", toolName: "move_clip", backend: "uxp", mode: "mutate", status: "RUNNING", preSnapshot: snapshot("before") });
    await ledger.append({ schemaVersion: 1, operationId: "read-running", recordedAt: "2026-08-28T00:00:00.000Z", toolName: "get_project_info", backend: "cep", mode: "read", status: "RUNNING" });
    const restarted = new OperationCoordinator(ledger);
    expect(await restarted.getRecoveryStatus()).toMatchObject({ quarantined: true, unresolved: [{ operationId: "crash-queued" }, { operationId: "crash-running" }] });
    const latest = new Map((await ledger.readEntries()).map((entry) => [entry.operationId, entry]));
    expect(latest.get("crash-queued")).toMatchObject({ status: "UNKNOWN", errorCode: "DAEMON_RESTART_OUTCOME_UNKNOWN" });
    expect(latest.get("crash-running")).toMatchObject({ status: "UNKNOWN", errorCode: "DAEMON_RESTART_OUTCOME_UNKNOWN" });
    expect(latest.get("read-running")).toMatchObject({ status: "RUNNING" });
  });

  it("accepts an explicit raw read only when the nested daemon request revalidates the exact script", async () => {
    const ledger = await tempLedger();
    const coordinator = new OperationCoordinator(ledger);
    const callerSource = "return __result({name: app.project.name});";
    const operationId = await coordinator.beginOperation({
      operationId: "00000000-0000-4000-8000-000000000010",
      toolName: "execute_extendscript",
      backend: "cep",
      mode: "read",
      timeoutMs: 30_000,
      queueDeadlineMs: 30_000,
      args: { code: callerSource },
    });

    await expect(coordinator.execute({
      operationId,
      toolName: "execute_extendscript",
      backend: "cep",
      mode: "read",
      timeoutMs: 30_000,
      queueDeadlineMs: 30_000,
      script: {
        ...payloadMetadata(wrapCepEvalScript(buildToolScript(callerSource))),
        source: wrapCepEvalScript(buildToolScript(callerSource)),
      },
      executor: async () => ({ name: "Project" }),
    })).resolves.toEqual({ name: "Project" });
    await expect(coordinator.endOperation(operationId, "SUCCEEDED")).resolves.toBe("SUCCEEDED");

    await expect(coordinator.beginOperation({
      operationId: "00000000-0000-4000-8000-000000000011",
      toolName: "execute_extendscript",
      backend: "cep",
      mode: "read",
      timeoutMs: 30_000,
      queueDeadlineMs: 30_000,
      args: { code: "app.project.save();" },
    })).rejects.toThrow(ToolPolicyError);

    await expect(coordinator.beginOperation({
      operationId: "00000000-0000-4000-8000-000000000012",
      toolName: "execute_extendscript",
      backend: "cep",
      mode: "read",
      timeoutMs: 30_000,
      queueDeadlineMs: 30_000,
      args: { code: "var p = app.project; p['save']();" },
    })).rejects.toThrow(ToolPolicyError);

    const mismatchId = await coordinator.beginOperation({
      operationId: "00000000-0000-4000-8000-000000000013",
      toolName: "execute_extendscript",
      backend: "cep",
      mode: "read",
      timeoutMs: 30_000,
      queueDeadlineMs: 30_000,
      args: { code: callerSource },
    });
    const mismatchedTransport = `${wrapCepEvalScript(buildToolScript(callerSource))}\napp.project.save();`;
    await expect(coordinator.execute({
      operationId: mismatchId,
      toolName: "execute_extendscript",
      backend: "cep",
      mode: "read",
      timeoutMs: 30_000,
      queueDeadlineMs: 30_000,
      script: {
        ...payloadMetadata(mismatchedTransport),
        source: mismatchedTransport,
      },
      executor: async () => undefined,
    })).rejects.toMatchObject({ code: "SCRIPT_POLICY_BINDING_MISMATCH" });
    await expect(coordinator.endOperation(mismatchId, "FAILED")).resolves.toBe("FAILED");
    expect(await coordinator.getRecoveryStatus()).toMatchObject({ quarantined: false, cepQueueDepth: 0, mutationQueueDepth: 0 });
  });

  it("serializes CEP execution while keeping queue and execution deadlines separate", async () => {
    const coordinator = new OperationCoordinator(await tempLedger());
    const order: string[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = coordinator.execute({
      operationId: "read-1", toolName: "get_project_info", backend: "cep", mode: "read",
      timeoutMs: 1_000, queueDeadlineMs: 1_000,
      executor: async () => { order.push("first-start"); markStarted(); await firstGate; order.push("first-end"); return 1; },
    });
    await started;
    const second = coordinator.execute({
      operationId: "read-2", toolName: "get_project_info", backend: "cep", mode: "read",
      timeoutMs: 1_000, queueDeadlineMs: 1_000,
      executor: async () => { order.push("second-start"); return 2; },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("holds a cross-backend mutation lease and allows same-operation CEP subrequests", async () => {
    const coordinator = new OperationCoordinator(await tempLedger());
    const operationId = await coordinator.beginOperation({
      operationId: "multi", toolName: "add_marker", backend: "uxp", mode: "mutate",
      timeoutMs: 1_000, queueDeadlineMs: 1_000,
    }, async () => snapshot("before"));
    await expect(coordinator.execute({
      operationId, toolName: "get_project_info", backend: "cep", mode: "read", timeoutMs: 1_000, queueDeadlineMs: 1_000,
      executor: async () => "subrequest",
    })).resolves.toBe("subrequest");
    const competing = coordinator.beginOperation({
      operationId: "other", toolName: "add_marker", backend: "cep", mode: "mutate", timeoutMs: 1_000, queueDeadlineMs: 10,
    }, async () => snapshot("other"));
    await expect(competing).rejects.toThrow(/expired while waiting/);
    await coordinator.endOperation(operationId, "SUCCEEDED", async () => snapshot("after"));
  });

  it("marks timeout UNKNOWN, quarantines mutations, and requires fingerprint acknowledgement", async () => {
    const ledger = await tempLedger();
    const coordinator = new OperationCoordinator(ledger);
    await expect(coordinator.execute({
      operationId: "unknown", toolName: "add_marker", backend: "uxp", mode: "mutate", timeoutMs: 5, queueDeadlineMs: 100,
      preflight: async () => snapshot("before"), postflight: async () => snapshot("after"),
      executor: async () => await new Promise<never>(() => undefined),
    })).rejects.toBeInstanceOf(OperationExecutionUnknownError);
    expect(await coordinator.compareReconnect("unknown", snapshot("before"))).toBe("BOUNDED_MATCH");
    expect(await coordinator.compareReconnect("unknown", snapshot("same-duration-but-different-state"))).toBe("CHANGED_FROM_PRE");
    expect((await coordinator.getRecoveryStatus()).quarantined).toBe(true);
    await expect(coordinator.beginOperation({ toolName: "add_marker", backend: "cep", mode: "mutate" }, async () => snapshot("x"))).rejects.toBeInstanceOf(MutationQuarantinedError);
    await expect(coordinator.acknowledgeUnknown({ operationId: "unknown", expectedFingerprint: "before", observedFingerprint: "different" })).rejects.toThrow(/fingerprint mismatch/);
    await coordinator.acknowledgeUnknown({ operationId: "unknown", expectedFingerprint: "before", observedFingerprint: "before" });
    expect((await coordinator.getRecoveryStatus()).quarantined).toBe(false);
    expect((await ledger.unresolvedUnknown())).toEqual([]);
  });

  it("releases CEP execution after mutation UNKNOWN while retaining the mutation quarantine lease", async () => {
    const coordinator = new OperationCoordinator(await tempLedger());
    await expect(coordinator.execute({
      operationId: "unknown-cep", toolName: "add_marker", backend: "cep", mode: "mutate", timeoutMs: 5, queueDeadlineMs: 100,
      preflight: async () => snapshot("before"), executor: async () => await new Promise<never>(() => undefined),
    })).rejects.toBeInstanceOf(OperationExecutionUnknownError);
    expect(await coordinator.getRecoveryStatus()).toMatchObject({ quarantined: true, cepQueueDepth: 0, mutationQueueDepth: 1 });
    await expect(coordinator.execute({ operationId: "diagnostic-read", toolName: "get_project_info", backend: "cep", mode: "read", timeoutMs: 100, queueDeadlineMs: 100, executor: async () => "ok" })).resolves.toBe("ok");
  });

  it("does not compare recovery fingerprints produced by different projection versions", async () => {
    const ledger = await tempLedger();
    await ledger.append({
      schemaVersion: 1, operationId: "legacy-unknown", recordedAt: "2026-08-27T00:00:00.000Z", toolName: "add_marker",
      backend: "cep", mode: "mutate", status: "UNKNOWN", preSnapshot: { fingerprint: "legacy", capturedAt: "2026-08-27T00:00:00.000Z" },
    });
    const coordinator = new OperationCoordinator(ledger);
    expect(await coordinator.compareReconnect("legacy-unknown", snapshot("different"))).toBe("INCOMPARABLE_PROJECTION");
  });

  it("leaves ordinary nested failure active for the caller's terminal end", async () => {
    const coordinator = new OperationCoordinator(await tempLedger());
    const operationId = await coordinator.beginOperation({
      operationId: "nested-failed", toolName: "add_marker", backend: "uxp", mode: "mutate", timeoutMs: 1_000, queueDeadlineMs: 1_000,
    }, async () => snapshot("before"));
    const failure = Object.assign(new Error("structured host failure"), { code: "UXP_COMMAND_FAILED" });
    await expect(coordinator.execute({
      operationId, toolName: "add_marker", backend: "uxp", mode: "mutate", timeoutMs: 1_000,
      executor: async () => { throw failure; },
    })).rejects.toMatchObject({ code: "UXP_COMMAND_FAILED" });
    await expect(coordinator.endOperation(operationId, "FAILED", undefined, "UXP_COMMAND_FAILED")).resolves.toBe("FAILED");
    expect((await coordinator.getRecoveryStatus()).quarantined).toBe(false);
  });

  it("makes nested UNKNOWN terminal, idempotent, and rejects further subrequests", async () => {
    const ledger = await tempLedger();
    const coordinator = new OperationCoordinator(ledger);
    const operationId = await coordinator.beginOperation({
      operationId: "nested-unknown", toolName: "add_marker", backend: "cep", mode: "mutate", timeoutMs: 5, queueDeadlineMs: 1_000,
    }, async () => snapshot("before"));
    await expect(coordinator.execute({
      operationId, toolName: "add_marker", backend: "cep", mode: "mutate", timeoutMs: 5,
      script: { ...payloadMetadata("actual-script"), source: "actual-script" },
      executor: async () => await new Promise<never>(() => undefined),
    })).rejects.toBeInstanceOf(OperationExecutionUnknownError);
    await expect(coordinator.endOperation(operationId, "UNKNOWN")).resolves.toBe("UNKNOWN");
    await expect(coordinator.endOperation(operationId, "UNKNOWN")).resolves.toBe("UNKNOWN");
    const terminal = (await ledger.readEntries()).at(-1);
    expect(terminal).toMatchObject({ status: "UNKNOWN", script: payloadMetadata("actual-script") });
    await expect(coordinator.execute({
      operationId, toolName: "add_marker", backend: "uxp", mode: "mutate", timeoutMs: 5,
      executor: async () => "must-not-run",
    })).rejects.toBeInstanceOf(OperationExecutionUnknownError);
  });

  it("does not quarantine mutations for a timed-out read and rejects durable operation id reuse", async () => {
    const coordinator = new OperationCoordinator(await tempLedger());
    await expect(coordinator.execute({
      operationId: "read-timeout", toolName: "get_project_info", backend: "cep", mode: "read", timeoutMs: 5, queueDeadlineMs: 100,
      executor: async () => await new Promise<never>(() => undefined),
    })).rejects.toThrow(/exceeded/);
    expect((await coordinator.getRecoveryStatus()).quarantined).toBe(false);

    const operationId = await coordinator.beginOperation({
      operationId: "durable-id", toolName: "get_project_info", backend: "cep", mode: "read", timeoutMs: 100, queueDeadlineMs: 100,
    });
    await coordinator.endOperation(operationId, "SUCCEEDED");
    await expect(coordinator.beginOperation({
      operationId: "durable-id", toolName: "get_project_info", backend: "cep", mode: "read", timeoutMs: 100, queueDeadlineMs: 100,
    })).rejects.toBeInstanceOf(OperationIdReusedError);
  });

  it("keeps explicit terminal mutation failure FAILED without quarantine or held queues", async () => {
    const coordinator = new OperationCoordinator(await tempLedger());
    await expect(coordinator.execute({
      operationId: "known-unsupported", toolName: "create_sequence", backend: "cep", mode: "mutate", timeoutMs: 100, queueDeadlineMs: 100,
      preflight: async () => snapshot("before"),
      executor: async () => { throw Object.assign(new Error("Not Enough Parameters"), { code: "UNSUPPORTED_HOST_API", outcomeUnknown: false }); },
    })).rejects.toThrow(/Not Enough Parameters/);
    expect(await coordinator.getRecoveryStatus()).toMatchObject({ quarantined: false, cepQueueDepth: 0, mutationQueueDepth: 0, unresolved: [] });
  });

  it("canonicalizes a directly requested read UNKNOWN terminal state to FAILED", async () => {
    const ledger = await tempLedger();
    const coordinator = new OperationCoordinator(ledger);
    const operationId = await coordinator.beginOperation({
      operationId: "read-direct-unknown", toolName: "get_project_info", backend: "cep", mode: "read", timeoutMs: 100, queueDeadlineMs: 100,
    });

    await expect(coordinator.endOperation(operationId, "UNKNOWN", undefined, "EXECUTION_TIMEOUT")).resolves.toBe("FAILED");
    expect((await ledger.readEntries()).at(-1)).toMatchObject({ status: "FAILED", errorCode: "EXECUTION_TIMEOUT" });
    expect((await coordinator.getRecoveryStatus()).quarantined).toBe(false);
  });

  it("never invokes a successful read postflight snapshot", async () => {
    const ledger = await tempLedger();
    const coordinator = new OperationCoordinator(ledger);
    let postflightCalls = 0;
    await expect(coordinator.execute({
      operationId: "read-no-postflight", toolName: "get_project_info", backend: "cep", mode: "read", timeoutMs: 100, queueDeadlineMs: 100,
      executor: async () => ({ project: "CUT" }),
      postflight: async () => { postflightCalls += 1; throw Object.assign(new Error("EvalScript error."), { code: "EXTENDSCRIPT_ERROR" }); },
    })).resolves.toEqual({ project: "CUT" });

    expect(postflightCalls).toBe(0);
    expect((await ledger.readEntries()).at(-1)).toMatchObject({ status: "SUCCEEDED" });
  });

  it("preserves mutation postflight UNKNOWN and quarantine behavior", async () => {
    const ledger = await tempLedger();
    const coordinator = new OperationCoordinator(ledger);
    await expect(coordinator.execute({
      operationId: "mutation-postflight-failure", toolName: "add_marker", backend: "cep", mode: "mutate", timeoutMs: 100, queueDeadlineMs: 100,
      preflight: async () => snapshot("before"),
      executor: async () => ({ changed: true }),
      postflight: async () => { throw Object.assign(new Error("EvalScript error."), { code: "EXTENDSCRIPT_ERROR" }); },
    })).rejects.toBeInstanceOf(OperationExecutionUnknownError);

    expect((await ledger.readEntries()).at(-1)).toMatchObject({ status: "UNKNOWN", errorCode: "EXTENDSCRIPT_ERROR" });
    expect((await coordinator.getRecoveryStatus()).quarantined).toBe(true);
  });

  it("serializes concurrent mutation finalization so the first terminal request wins", async () => {
    const ledger = await tempLedger();
    const coordinator = new OperationCoordinator(ledger);
    const operationId = await coordinator.beginOperation({
      operationId: "concurrent-finalization", toolName: "add_marker", backend: "cep", mode: "mutate", timeoutMs: 1_000, queueDeadlineMs: 1_000,
    }, async () => snapshot("before"));
    let postflightStarted!: () => void;
    const started = new Promise<void>((resolve) => { postflightStarted = resolve; });
    let releasePostflight!: () => void;
    const gate = new Promise<void>((resolve) => { releasePostflight = resolve; });

    const succeeded = coordinator.endOperation(operationId, "SUCCEEDED", async () => {
      postflightStarted();
      await gate;
      return snapshot("after");
    });
    await started;
    const racedUnknown = coordinator.endOperation(operationId, "UNKNOWN", undefined, "EXECUTION_TIMEOUT");
    releasePostflight();

    await expect(Promise.all([succeeded, racedUnknown])).resolves.toEqual(["SUCCEEDED", "SUCCEEDED"]);
    const entries = await ledger.readEntries();
    expect(entries.filter((entry) => ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(entry.status))).toHaveLength(1);
    expect(entries.at(-1)).toMatchObject({ status: "SUCCEEDED", postSnapshot: snapshot("after") });
    expect((await coordinator.getRecoveryStatus()).quarantined).toBe(false);
    expect((await coordinator.getRecoveryStatus()).unresolved).toEqual([]);
  });

  it("returns the first terminal result for duplicate calls without appending again", async () => {
    const ledger = await tempLedger();
    const coordinator = new OperationCoordinator(ledger);
    const operationId = await coordinator.beginOperation({
      operationId: "duplicate-terminal", toolName: "get_project_info", backend: "cep", mode: "read", timeoutMs: 100, queueDeadlineMs: 100,
    });

    await expect(coordinator.endOperation(operationId, "UNKNOWN", undefined, "EXECUTION_TIMEOUT")).resolves.toBe("FAILED");
    await expect(coordinator.endOperation(operationId, "SUCCEEDED")).resolves.toBe("FAILED");
    await expect(coordinator.endOperation(operationId, "UNKNOWN")).resolves.toBe("FAILED");
    const entries = await ledger.readEntries();
    expect(entries.filter((entry) => ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(entry.status))).toHaveLength(1);
    expect(entries.at(-1)).toMatchObject({ status: "FAILED", errorCode: "EXECUTION_TIMEOUT" });
    await expect(coordinator.beginOperation({
      operationId: "duplicate-terminal", toolName: "get_project_info", backend: "cep", mode: "read", timeoutMs: 100, queueDeadlineMs: 100,
    })).rejects.toBeInstanceOf(OperationIdReusedError);
  });
});
