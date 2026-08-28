import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  APPROVED_CEP_EXTENSION_ID,
  CEP_BRIDGE_PROTOCOL_VERSION,
  MAX_EXECUTION_TIMEOUT_MS,
  MIN_EXECUTION_TIMEOUT_MS,
  normalizeExecutionTimeout,
} from "../src/bridge-types.js";
import { BridgeClient, BridgeExecutionError } from "../src/bridge/ws-client.js";
import { WsHost } from "../src/bridge/ws-host.js";
import { sendRawCommand } from "../vendor/upstream/bridge/file-bridge.js";

let host: WsHost | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  if (host) {
    await host.close();
    host = null;
  }
});

async function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message")), 2_000);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
}

function testIdentity(instanceId: string): Record<string, unknown> {
  return {
    extensionId: APPROVED_CEP_EXTENSION_ID,
    protocolVersion: CEP_BRIDGE_PROTOCOL_VERSION,
    bridgeVersion: "test",
    instanceId,
  };
}

async function readyCep(socket: WebSocket, premiereVersion: string, instanceId = `test-${premiereVersion}`): Promise<Record<string, unknown>> {
  const hello = nextMessage(socket);
  socket.send(JSON.stringify({ kind: "ready", identity: testIdentity(instanceId), premiereVersion }));
  return await hello;
}

describe("bridge request lifecycle", () => {
  it("normalizes a finite bounded timeout and passes tool timeout to the transport", async () => {
    expect(normalizeExecutionTimeout(-1)).toBe(MIN_EXECUTION_TIMEOUT_MS);
    expect(normalizeExecutionTimeout(Number.NaN, 4_321)).toBe(4_321);
    expect(normalizeExecutionTimeout(Number.POSITIVE_INFINITY)).toBe(MAX_EXECUTION_TIMEOUT_MS);

    let receivedTimeout: number | undefined;
    const result = await sendRawCommand("return 1;", {
      timeoutMs: 1_234,
      transport: {
        executeScript: async (_script: string, timeoutMs?: number) => {
          receivedTimeout = timeoutMs;
          return { success: true, data: 1 };
        },
      },
    });
    expect(receivedTimeout).toBe(1_234);
    expect(result).toEqual({ success: true, data: 1 });
  });

  it("forwards the normalized request timeout to CEP", async () => {
    host = await WsHost.start(0, { heartbeatMs: 0 });
    const cep = await connect(host.port);
    await readyCep(cep, "26.3");
    const mcp = await connect(host.port);

    const executeAtCep = nextMessage(cep);
    mcp.send(JSON.stringify({ kind: "execute", requestId: "bounded", script: "return 1;", timeoutMs: 1 }));
    const request = await executeAtCep;
    expect(request.timeoutMs).toBe(MIN_EXECUTION_TIMEOUT_MS);
    cep.send(JSON.stringify({ kind: "response", requestId: "bounded", ok: true, data: "1" }));
    expect(await nextMessage(mcp)).toMatchObject({ kind: "response", requestId: "bounded", ok: true });
  });

  it("fails pending work immediately when CEP disconnects", async () => {
    host = await WsHost.start(0, { heartbeatMs: 0 });
    const cep = await connect(host.port);
    await readyCep(cep, "26.3");
    const mcp = await connect(host.port);

    const received = nextMessage(cep);
    const reply = nextMessage(mcp);
    mcp.send(JSON.stringify({ kind: "execute", requestId: "disconnect", script: "return 1;", timeoutMs: 30_000 }));
    await received;
    cep.close();

    expect(await reply).toMatchObject({
      kind: "response",
      requestId: "disconnect",
      ok: false,
      error: { code: "HOST_DISCONNECTED" },
    });
  });

  it("rejects an invalid ready without replacing the active CEP or incrementing generation", async () => {
    host = await WsHost.start(0, { heartbeatMs: 0 });
    const approved = await connect(host.port);
    const approvedHello = await readyCep(approved, "26.3", "approved-runtime");
    expect(approvedHello).toMatchObject({ host: { generation: 1, identity: testIdentity("approved-runtime") } });

    const invalidReadyMessages = [
      { kind: "ready", premiereVersion: "99.0" },
      { kind: "ready", identity: { ...testIdentity("wrong-id"), extensionId: "com.local.ppmcp.cep.2026" }, premiereVersion: "99.0" },
      { kind: "ready", identity: { ...testIdentity("wrong-protocol"), protocolVersion: CEP_BRIDGE_PROTOCOL_VERSION + 1 }, premiereVersion: "99.0" },
    ];
    let rejected!: WebSocket;
    for (const invalidReady of invalidReadyMessages) {
      rejected = await connect(host.port);
      const rejection = nextMessage(rejected);
      rejected.send(JSON.stringify(invalidReady));
      expect(await rejection).toMatchObject({
        kind: "hello",
        ok: false,
        error: {
          code: "CEP_HOST_REJECTED",
          expectedExtensionId: APPROVED_CEP_EXTENSION_ID,
          expectedProtocolVersion: CEP_BRIDGE_PROTOCOL_VERSION,
        },
      });
    }

    const statusReply = nextMessage(rejected);
    rejected.send(JSON.stringify({ kind: "operation_status", requestId: "identity-status" }));
    expect(await statusReply).toMatchObject({
      ok: true,
      data: {
        cep: { connected: true, identity: testIdentity("approved-runtime") },
        session: { generation: 1, premiereVersion: "26.3", identity: testIdentity("approved-runtime") },
      },
    });

    const mcp = await connect(host.port);
    const routed = nextMessage(approved);
    mcp.send(JSON.stringify({ kind: "execute", requestId: "still-approved", script: "return 1;" }));
    expect(await routed).toMatchObject({ kind: "execute", requestId: "still-approved" });
    approved.send(JSON.stringify({ kind: "response", requestId: "still-approved", ok: true, data: "1" }));
    expect(await nextMessage(mcp)).toMatchObject({ ok: true, data: "1" });
  });

  it("binds pending responses to the CEP session and keeps HOST_REPLACED for an approved replacement", async () => {
    host = await WsHost.start(0, { heartbeatMs: 0 });
    const cep1 = await connect(host.port);
    await readyCep(cep1, "old", "old-runtime");
    const mcp = await connect(host.port);

    const oldReceived = nextMessage(cep1);
    const replacedReply = nextMessage(mcp);
    mcp.send(JSON.stringify({ kind: "execute", requestId: "old-work", script: "return 1;" }));
    await oldReceived;

    const cep2 = await connect(host.port);
    const hello2 = await readyCep(cep2, "new", "new-runtime");
    expect(hello2).toMatchObject({
      host: {
        version: "new",
        premiereVersion: "new",
        generation: 2,
        identity: testIdentity("new-runtime"),
      },
    });
    expect(await replacedReply).toMatchObject({ ok: false, error: { code: "HOST_REPLACED" } });

    const newReceived = nextMessage(cep2);
    const newReply = nextMessage(mcp);
    mcp.send(JSON.stringify({ kind: "execute", requestId: "new-work", script: "return 2;" }));
    await newReceived;
    cep1.send(JSON.stringify({ kind: "response", requestId: "new-work", ok: true, data: "stale" }));
    cep2.send(JSON.stringify({ kind: "response", requestId: "new-work", ok: true, data: "fresh" }));
    expect(await newReply).toMatchObject({ ok: true, data: "fresh" });
  });

  it("runs an application-level host probe and exposes the host generation", async () => {
    host = await WsHost.start(0, { heartbeatMs: 0 });
    const cep = await connect(host.port);
    const hello = await readyCep(cep, "26.3");
    const session = hello.host as { sessionId: string; generation: number };
    const client = await BridgeClient.connect(host.port);

    cep.once("message", (raw) => {
      const request = JSON.parse(raw.toString()) as { kind: string; requestId: string; timeoutMs: number };
      expect(request).toMatchObject({ kind: "host_probe", timeoutMs: 1_500 });
      cep.send(JSON.stringify({ kind: "response", requestId: request.requestId, ok: true, data: true }));
    });
    const result = await client.probeHost(1_500);
    expect(result).toEqual({
      connected: true,
      responsive: true,
      version: "26.3",
      premiereVersion: "26.3",
      identity: testIdentity("test-26.3"),
      sessionId: session.sessionId,
      generation: session.generation,
    });
    expect(client.hostSession).toEqual({
      version: "26.3",
      premiereVersion: "26.3",
      identity: testIdentity("test-26.3"),
      sessionId: session.sessionId,
      generation: 1,
    });
    await client.close();
  });

  it("runs a distinct serialized DOM readiness probe without changing the host session", async () => {
    host = await WsHost.start(0, { heartbeatMs: 0 });
    const cep = await connect(host.port);
    const hello = await readyCep(cep, "26.3", "dom-runtime");
    const session = hello.host as { sessionId: string; generation: number };
    const client = await BridgeClient.connect(host.port);

    const execution = client.executeScript("return 1;", 1_000);
    const executeRequest = await nextMessage(cep);
    expect(executeRequest.kind).toBe("execute");
    const probe = client.probeDomReadiness(1_000);
    let probeArrived = false;
    const probeRequestPromise = nextMessage(cep).then((message) => { probeArrived = true; return message; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(probeArrived).toBe(false);
    cep.send(JSON.stringify({ kind: "response", requestId: executeRequest.requestId, ok: true, data: "1" }));
    await expect(execution).resolves.toBe("1");

    const probeRequest = await probeRequestPromise;
    expect(probeRequest).toMatchObject({ kind: "dom_readiness_probe", timeoutMs: 1_000 });
    cep.send(JSON.stringify({
      kind: "response", requestId: probeRequest.requestId, ok: true,
      data: { ok: true, projectOpen: true, projectName: "MEDIA_RELINKED.prproj", activeSequence: { id: "seq-1", name: "CUT" } },
    }));
    await expect(probe).resolves.toMatchObject({
      transportResponsive: true, domReady: true, projectOpen: true,
      projectName: "MEDIA_RELINKED.prproj", activeSequence: { id: "seq-1", name: "CUT" },
      sessionId: session.sessionId, generation: session.generation,
    });
    expect(client.hostSession).toMatchObject({ sessionId: session.sessionId, generation: 1, identity: testIdentity("dom-runtime") });

    const raw = await connect(host.port);
    const statusReply = nextMessage(raw);
    raw.send(JSON.stringify({ kind: "operation_status", requestId: "dom-status" }));
    expect(await statusReply).toMatchObject({
      data: {
        modalState: "unknown",
        domReadiness: {
          domReady: true, errorCode: null, consecutiveSuccesses: 1,
          sessionId: session.sessionId, generation: 1,
        },
      },
    });
    await client.close();
  });

  it.each([
    ["EXTENDSCRIPT_ERROR", "EvalScript error"],
    ["DOM_READINESS_INVALID_RESPONSE", "malformed payload"],
    ["DOM_PROBE_SCRIPT_ERROR", "project DOM failed"],
    ["DOM_READINESS_TIMEOUT", "probe timed out"],
  ])("preserves DOM readiness failure classification %s and resets its success streak", async (code, message) => {
    host = await WsHost.start(0, { heartbeatMs: 0 });
    const cep = await connect(host.port);
    const hello = await readyCep(cep, "26.3");
    const session = hello.host as { sessionId: string; generation: number };
    const client = await BridgeClient.connect(host.port);

    const success = client.probeDomReadiness(1_000);
    const successRequest = await nextMessage(cep);
    cep.send(JSON.stringify({ kind: "response", requestId: successRequest.requestId, ok: true, data: { ok: true, projectOpen: false, projectName: null, activeSequence: null } }));
    await success;

    const failed = client.probeDomReadiness(1_000);
    const failedRequest = await nextMessage(cep);
    cep.send(JSON.stringify({ kind: "response", requestId: failedRequest.requestId, ok: false, error: { code, message } }));
    await expect(failed).rejects.toMatchObject({ code });

    const raw = await connect(host.port);
    const statusReply = nextMessage(raw);
    raw.send(JSON.stringify({ kind: "operation_status", requestId: `status-${code}` }));
    expect(await statusReply).toMatchObject({
      data: { domReadiness: { domReady: false, errorCode: code, consecutiveSuccesses: 0, sessionId: session.sessionId, generation: 1 } },
    });
    await client.close();
  });

  it("classifies a malformed successful DOM payload at the daemon seam", async () => {
    host = await WsHost.start(0, { heartbeatMs: 0 });
    const cep = await connect(host.port);
    await readyCep(cep, "26.3");
    const client = await BridgeClient.connect(host.port);
    const probe = client.probeDomReadiness(1_000);
    const request = await nextMessage(cep);
    cep.send(JSON.stringify({ kind: "response", requestId: request.requestId, ok: true, data: { ok: true, projectOpen: "yes" } }));
    await expect(probe).rejects.toMatchObject({ code: "DOM_READINESS_INVALID_RESPONSE" });
    await client.close();
  });

  it("maps a daemon-side DOM callback timeout without making the outcome unknown", async () => {
    host = await WsHost.start(0, { heartbeatMs: 0 });
    const cep = await connect(host.port);
    await readyCep(cep, "26.3");
    const client = await BridgeClient.connect(host.port);
    const probe = client.probeDomReadiness(MIN_EXECUTION_TIMEOUT_MS);
    expect(await nextMessage(cep)).toMatchObject({ kind: "dom_readiness_probe", timeoutMs: MIN_EXECUTION_TIMEOUT_MS });
    await expect(probe).rejects.toMatchObject({ code: "DOM_READINESS_TIMEOUT", outcomeUnknown: undefined });
    await client.close();
  });

  it("invalidates current DOM readiness when the active CEP disconnects", async () => {
    host = await WsHost.start(0, { heartbeatMs: 0 });
    const cep = await connect(host.port);
    await readyCep(cep, "26.3");
    const client = await BridgeClient.connect(host.port);
    const probe = client.probeDomReadiness(1_000);
    const request = await nextMessage(cep);
    cep.send(JSON.stringify({ kind: "response", requestId: request.requestId, ok: true, data: { ok: true, projectOpen: true, projectName: "Project", activeSequence: null } }));
    await probe;

    cep.close();
    const deadline = Date.now() + 2_000;
    let status: Record<string, unknown> = {};
    do {
      status = await client.operationStatus() as unknown as Record<string, unknown>;
      const readiness = status.domReadiness as { errorCode?: unknown } | undefined;
      if (readiness?.errorCode === "HOST_DISCONNECTED") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    expect(status).toMatchObject({
      session: null,
      domReadiness: {
        lastCheckedAt: expect.any(String), lastSuccessfulAt: expect.any(String),
        domReady: false, errorCode: "HOST_DISCONNECTED", consecutiveSuccesses: 0,
        sessionId: null, generation: null,
      },
    });
    await client.close();
  });

  it("rejects BridgeClient waiters when the client closes", async () => {
    host = await WsHost.start(0, { heartbeatMs: 0 });
    const cep = await connect(host.port);
    await readyCep(cep, "26.3");
    const client = await BridgeClient.connect(host.port);

    const received = nextMessage(cep);
    const execution = client.executeScript("return 1;", 30_000);
    await received;
    await client.close();
    await expect(execution).rejects.toThrow("Bridge client closed");
  });

  it("terminates a transport that stops answering WebSocket pings", async () => {
    host = await WsHost.start(0, { heartbeatMs: 20 });
    const cep = await connect(host.port);
    await readyCep(cep, "26.3");
    const rawSocket = (cep as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    rawSocket.pause();

    const deadline = Date.now() + 1_000;
    while (host.connected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    rawSocket.resume();
    expect(host.connected).toBe(false);
  });

  it("marks timed-out execution as unknown and forwards a late completion with metadata", async () => {
    host = await WsHost.start(0, { heartbeatMs: 0 });
    const cep = await connect(host.port);
    await readyCep(cep, "26.3");
    const mcp = await connect(host.port);
    const operation = { operationId: "op-1", sequenceId: "seq-2" };

    const received = nextMessage(cep);
    mcp.send(JSON.stringify({
      kind: "execute",
      requestId: "late",
      script: "return 1;",
      timeoutMs: MIN_EXECUTION_TIMEOUT_MS,
      operation,
    }));
    expect(await received).toMatchObject({ timeoutMs: MIN_EXECUTION_TIMEOUT_MS, operation });
    expect(await nextMessage(mcp)).toMatchObject({
      kind: "response",
      requestId: "late",
      ok: false,
      operation,
      error: { code: "EXECUTION_TIMEOUT", retryable: false, outcomeUnknown: true },
    });

    const late = nextMessage(mcp);
    cep.send(JSON.stringify({ kind: "late_completion", requestId: "late", ok: true, data: "1" }));
    expect(await late).toEqual({ kind: "late_completion", requestId: "late", ok: true, data: "1", operation });
  });

  it("rejects execution with structured unknown outcome when the daemon disconnects", async () => {
    host = await WsHost.start(0, { heartbeatMs: 0 });
    const cep = await connect(host.port);
    await readyCep(cep, "26.3");
    const client = await BridgeClient.connect(host.port);
    const received = nextMessage(cep);
    const execution = client.executeScript("return 1;", 30_000, { operationId: "op-disconnect" });
    const outcome = execution.catch((error: unknown) => error);
    await received;

    await host.close();
    host = null;
    await expect(outcome).resolves.toMatchObject({
      name: "BridgeExecutionError",
      code: "BRIDGE_DISCONNECTED",
      retryable: false,
      outcomeUnknown: true,
      operation: { operationId: "op-disconnect" },
    } satisfies Partial<BridgeExecutionError>);
  });
});
