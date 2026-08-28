import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer, type BridgeClient } from "../src/server.js";
import type { OperationWireMetadata } from "../src/bridge-types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

interface BridgeTrace {
  executes: Array<{ script: string; timeoutMs?: number; operation?: OperationWireMetadata }>;
  begins: Array<Record<string, unknown>>;
  ends: Array<{ operationId: string; status: string; code?: string }>;
}

function mockBridge(trace: BridgeTrace, execute?: BridgeClient["executeScript"]): BridgeClient {
  return {
    connected: true,
    port: 48210,
    hostSession: { sessionId: "host-1", generation: 1 },
    executeScript: execute ?? (async (script, timeoutMs, operation) => {
      trace.executes.push({ script, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(operation === undefined ? {} : { operation }) });
      return { success: true, data: { ok: true } };
    }),
    uxp: async () => ({ success: false, code: "UXP_MOCK", error: "mock" }),
    beginOperation: async (request) => { trace.begins.push(request as unknown as Record<string, unknown>); return request.operationId; },
    endOperation: async (operationId, status, code) => {
      trace.ends.push({ operationId, status, ...(code === undefined ? {} : { code }) });
      return status;
    },
    operationStatus: async () => ({ quarantined: false, unresolved: [] }),
  };
}

async function connectedClient(bridge: BridgeClient): Promise<Client> {
  const server = createMcpServer(bridge);
  const client = new Client({ name: "operation-safety-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanup.push(() => client.close(), () => server.close());
  return client;
}

describe("server operation safety", () => {
  it("accepts a bounded 120-second raw script and propagates its timeout", async () => {
    const trace: BridgeTrace = { executes: [], begins: [], ends: [] };
    const client = await connectedClient(mockBridge(trace));
    const result = await client.callTool({
      name: "premiere_execute_extendscript",
      arguments: { code: "return __result({ok:true});", timeout_ms: 120_000 },
    });

    expect(result.isError).not.toBe(true);
    expect(trace.executes).toHaveLength(1);
    expect(trace.executes[0]?.timeoutMs).toBe(120_000);
    expect(trace.executes[0]?.operation?.toolName).toBe("execute_extendscript");
    expect(trace.ends.at(-1)?.status).toBe("SUCCEEDED");
  });

  it("accepts caller source near 16 KiB when the generated helper script remains under 64 KiB", async () => {
    const trace: BridgeTrace = { executes: [], begins: [], ends: [] };
    const client = await connectedClient(mockBridge(trace));
    const code = `var note = "${"x".repeat(15_000)}"; return __result({length: note.length});`;
    const result = await client.callTool({ name: "premiere_execute_extendscript", arguments: { code, timeout_ms: 120_000 } });

    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(trace.executes[0]!.script, "utf8")).toBeGreaterThan(16 * 1024);
    expect(Buffer.byteLength(trace.executes[0]!.script, "utf8")).toBeLessThan(64 * 1024);
  });

  it("rejects raw scripts that mix placement, keyframes, and save before host dispatch", async () => {
    const trace: BridgeTrace = { executes: [], begins: [], ends: [] };
    const client = await connectedClient(mockBridge(trace));
    const result = await client.callTool({
      name: "premiere_execute_extendscript",
      arguments: {
        code: "seq.overwriteClip(item, 0); prop.addKey(t); app.project.save(); return __result({});",
        timeout_ms: 120_000,
      },
    });

    expect(result.isError).toBe(true);
    expect(trace.begins).toHaveLength(0);
    expect(trace.executes).toHaveLength(0);
  });

  it("does not let evaluate_expression bypass the mutation policy", async () => {
    const trace: BridgeTrace = { executes: [], begins: [], ends: [] };
    const client = await connectedClient(mockBridge(trace));
    const result = await client.callTool({
      name: "premiere_evaluate_expression",
      arguments: { expression: "app.project.save()" },
    });

    expect(result.isError).toBe(true);
    expect(trace.executes).toHaveLength(0);
  });

  it("records target sequence and script metadata for a mutation", async () => {
    const trace: BridgeTrace = { executes: [], begins: [], ends: [] };
    const client = await connectedClient(mockBridge(trace));
    await client.callTool({
      name: "premiere_set_sequence_frame_rate",
      arguments: { sequence_id: "CUT_02", frame_rate: 30 },
    });

    expect(trace.begins[0]).toMatchObject({ toolName: "set_sequence_frame_rate", mode: "mutate", targetHint: "CUT_02", targetKind: "sequence" });
    expect(trace.executes[0]?.operation).toMatchObject({ toolName: "set_sequence_frame_rate", mode: "mutate", backend: "cep" });
    expect(trace.executes[0]?.operation?.scriptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(trace.ends.at(-1)?.status).toBe("SUCCEEDED");
  });

  it("marks a timed-out mutation UNKNOWN instead of reporting a safe failure", async () => {
    const trace: BridgeTrace = { executes: [], begins: [], ends: [] };
    const execute: BridgeClient["executeScript"] = async () => {
      throw Object.assign(new Error("host execution timed out"), {
        code: "EXECUTION_TIMEOUT",
        retryable: false,
        outcomeUnknown: true,
      });
    };
    const client = await connectedClient(mockBridge(trace, execute));
    const result = await client.callTool({
      name: "premiere_set_sequence_frame_rate",
      arguments: { sequence_id: "CUT_02", frame_rate: 30 },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ success: false, code: "EXECUTION_TIMEOUT", retryable: false, outcomeUnknown: true });
    expect(trace.ends.at(-1)?.status).toBe("UNKNOWN");
  });

  it("terminates a direct read ExtendScript failure as FAILED", async () => {
    const trace: BridgeTrace = { executes: [], begins: [], ends: [] };
    const execute: BridgeClient["executeScript"] = async () => ({
      success: false,
      code: "EXTENDSCRIPT_ERROR",
      error: "EvalScript error.",
      retryable: false,
    });
    const client = await connectedClient(mockBridge(trace, execute));
    const result = await client.callTool({ name: "premiere_get_project_info", arguments: {} });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ success: false, code: "EXTENDSCRIPT_ERROR", error: "EvalScript error." });
    expect(trace.ends.at(-1)).toMatchObject({ status: "FAILED", code: "EXTENDSCRIPT_ERROR" });
  });

  it("terminates an outcome-unknown read timeout as FAILED without dropping diagnostics", async () => {
    const trace: BridgeTrace = { executes: [], begins: [], ends: [] };
    const execute: BridgeClient["executeScript"] = async () => ({
      success: false,
      code: "EXECUTION_TIMEOUT",
      error: "host callback timed out",
      retryable: false,
      outcomeUnknown: true,
    });
    const client = await connectedClient(mockBridge(trace, execute));
    const result = await client.callTool({ name: "premiere_get_project_info", arguments: {} });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      success: false,
      code: "EXECUTION_TIMEOUT",
      error: "host callback timed out",
      retryable: false,
      outcomeUnknown: true,
    });
    expect(trace.ends.at(-1)).toMatchObject({ status: "FAILED", code: "EXECUTION_TIMEOUT" });
  });

  it("forwards recovery acknowledgement through the scoped bridge", async () => {
    const trace: BridgeTrace = { executes: [], begins: [], ends: [] };
    const bridge = mockBridge(trace);
    bridge.acknowledgeRecovery = async (operationId, expectedFingerprint) => ({
      success: true,
      operationId,
      observedFingerprint: expectedFingerprint,
    });
    const client = await connectedClient(bridge);
    const result = await client.callTool({
      name: "premiere_health_check",
      arguments: {
        mode: "acknowledge_recovery",
        recovery_operation_id: "00000000-0000-4000-8000-000000000001",
        expected_fingerprint: "f".repeat(64),
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      success: true,
      operationId: "00000000-0000-4000-8000-000000000001",
      observedFingerprint: "f".repeat(64),
    });
  });

  it("forwards scoped host status and health probes", async () => {
    const trace: BridgeTrace = { executes: [], begins: [], ends: [] };
    const bridge = mockBridge(trace);
    let probeTimeout: number | undefined;
    bridge.probeHost = async (timeoutMs) => {
      probeTimeout = timeoutMs;
      return { marker: "probe-forwarded", responsive: true };
    };
    bridge.operationStatus = async () => ({ marker: "status-forwarded" });
    const client = await connectedClient(bridge);

    const connection = await client.callTool({
      name: "premiere_connection_status",
      arguments: {},
    });
    expect(connection.structuredContent).toMatchObject({
      hostSession: { sessionId: "host-1", generation: 1 },
      operationStatus: { marker: "status-forwarded" },
    });

    const health = await client.callTool({
      name: "premiere_health_check",
      arguments: { mode: "probe" },
    });
    expect(probeTimeout).toBe(5_000);
    expect(health.structuredContent).toMatchObject({
      success: true,
      port: 48210,
      responsive: true,
      probe: { marker: "probe-forwarded", responsive: true },
      operationStatus: { marker: "status-forwarded" },
    });
  });

  it("preserves the no-argument health contract and derives responsiveness from the probe", async () => {
    const trace: BridgeTrace = { executes: [], begins: [], ends: [] };
    const bridge = mockBridge(trace);
    bridge.probeHost = async () => ({ responsive: false, reason: "host-busy" });
    const client = await connectedClient(bridge);

    const health = await client.callTool({ name: "premiere_health_check", arguments: {} });
    expect(health.structuredContent).toMatchObject({
      success: true,
      connected: true,
      port: 48210,
      responsive: false,
      modalState: "unknown",
      probe: { responsive: false, reason: "host-busy" },
    });
  });

  it("reports an unsupported null response when the bridge has no host probe", async () => {
    const trace: BridgeTrace = { executes: [], begins: [], ends: [] };
    const client = await connectedClient(mockBridge(trace));

    const health = await client.callTool({ name: "premiere_health_check", arguments: {} });
    expect(health.structuredContent).toMatchObject({
      success: false,
      connected: true,
      port: 48210,
      responsive: null,
      modalState: "unknown",
      code: "HOST_PROBE_UNSUPPORTED",
    });
  });

  it("forwards the additive DOM-readiness probe without changing the default probe mode", async () => {
    const trace: BridgeTrace = { executes: [], begins: [], ends: [] };
    const bridge = mockBridge(trace);
    const calls: string[] = [];
    bridge.probeHost = async () => { calls.push("host"); return { marker: "host-probe", responsive: true }; };
    let domState = { domReadiness: { domReady: false, consecutiveSuccesses: 0 } };
    bridge.probeDomReadiness = async (timeoutMs) => {
      calls.push(`dom:${timeoutMs}`);
      domState = { domReadiness: { domReady: true, consecutiveSuccesses: 1 } };
      return { marker: "dom-probe", projectName: "CUT" };
    };
    bridge.operationStatus = async () => domState;
    const client = await connectedClient(bridge);

    const defaultHealth = await client.callTool({ name: "premiere_health_check", arguments: {} });
    expect(defaultHealth.structuredContent).toMatchObject({ success: true, responsive: true, probe: { marker: "host-probe" } });
    expect(defaultHealth.structuredContent).not.toHaveProperty("domReady");

    const domHealth = await client.callTool({ name: "premiere_health_check", arguments: { mode: "dom_readiness" } });
    expect(calls).toEqual(["host", "dom:5000"]);
    expect(domHealth.structuredContent).toMatchObject({
      success: true,
      connected: true,
      transportResponsive: true,
      domReady: true,
      modalState: "unknown",
      probe: { marker: "dom-probe", projectName: "CUT" },
      operationStatus: { domReadiness: { domReady: true, consecutiveSuccesses: 1 } },
    });
  });

  it("distinguishes callback-level DOM failures from transport failures", async () => {
    const trace: BridgeTrace = { executes: [], begins: [], ends: [] };
    const bridge = mockBridge(trace);
    let domState = { domReadiness: { domReady: true, consecutiveSuccesses: 2, error: null as string | null } };
    bridge.operationStatus = async () => domState;
    bridge.probeDomReadiness = async () => {
      domState = { domReadiness: { domReady: false, consecutiveSuccesses: 0, error: "EvalScript error." } };
      throw Object.assign(new Error("EvalScript error."), { code: "EXTENDSCRIPT_ERROR" });
    };
    const client = await connectedClient(bridge);

    const callbackFailure = await client.callTool({ name: "premiere_health_check", arguments: { mode: "dom_readiness" } });
    expect(callbackFailure.structuredContent).toMatchObject({
      success: false,
      connected: true,
      transportResponsive: true,
      domReady: false,
      modalState: "unknown",
      code: "EXTENDSCRIPT_ERROR",
      error: "EvalScript error.",
      operationStatus: { domReadiness: { domReady: false, consecutiveSuccesses: 0, error: "EvalScript error." } },
    });

    bridge.probeDomReadiness = async () => {
      domState = { domReadiness: { domReady: false, consecutiveSuccesses: 0, error: "host execution timed out" } };
      throw Object.assign(new Error("host execution timed out"), { code: "EXECUTION_TIMEOUT" });
    };
    const transportFailure = await client.callTool({ name: "premiere_health_check", arguments: { mode: "dom_readiness" } });
    expect(transportFailure.structuredContent).toMatchObject({
      success: false,
      connected: true,
      transportResponsive: false,
      domReady: false,
      code: "EXECUTION_TIMEOUT",
      error: "host execution timed out",
    });
  });
});
