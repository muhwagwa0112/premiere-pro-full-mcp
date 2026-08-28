import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { APPROVED_CEP_EXTENSION_ID, CEP_BRIDGE_PROTOCOL_VERSION } from "../src/bridge-types.js";
import { BridgeClient, BridgeExecutionError } from "../src/bridge/ws-client.js";
import { WsHost } from "../src/bridge/ws-host.js";
import { OperationCoordinator } from "../src/operations/coordinator.js";
import { OperationLedger, payloadMetadata } from "../src/operations/ledger.js";
import type { UxpBridgeHost } from "../src/bridge/uxp-host.js";
import { buildToolScript } from "../vendor/upstream/bridge/script-builder.js";

let host: WsHost | null = null;
let operationLedger: OperationLedger | null = null;
const sockets: WebSocket[] = [];
const clients: BridgeClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const socket of sockets.splice(0)) socket.terminate();
  if (host) await host.close();
  host = null;
  operationLedger = null;
});

async function startCoordinatedHost(options: { snapshotBudgetMs?: number } = {}): Promise<WsHost> {
  const ledger = new OperationLedger(await mkdtemp(join(tmpdir(), "premiere-wire-operations-")));
  operationLedger = ledger;
  host = await WsHost.start(0, { heartbeatMs: 0, coordinator: new OperationCoordinator(ledger), ...options });
  return host;
}
async function connectSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return socket;
}
async function connectClient(port: number): Promise<BridgeClient> {
  const client = await BridgeClient.connect(port);
  clients.push(client);
  return client;
}
function nextMessage(socket: WebSocket, timeoutMs = 2_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for bridge message")), timeoutMs);
    socket.once("message", (raw) => { clearTimeout(timer); resolve(JSON.parse(raw.toString()) as Record<string, unknown>); });
  });
}
function nextMessages(socket: WebSocket, count: number, timeoutMs = 2_000): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const timer = setTimeout(() => { socket.off("message", onMessage); reject(new Error("Timed out waiting for bridge messages")); }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData): void => {
      messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      if (messages.length !== count) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(messages);
    };
    socket.on("message", onMessage);
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
async function readyCep(socket: WebSocket, premiereVersion = "26.3", instanceId = `test-${premiereVersion}`): Promise<void> {
  const hello = nextMessage(socket);
  socket.send(JSON.stringify({ kind: "ready", identity: testIdentity(instanceId), premiereVersion }));
  await hello;
}
async function answerNextCep(socket: WebSocket, data: unknown): Promise<Record<string, unknown>> {
  const request = await nextMessage(socket);
  socket.send(JSON.stringify({ kind: "response", requestId: request.requestId, ok: true, data }));
  return request;
}
async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = await read();
  }
  return value;
}

describe("operation-aware bridge wire", () => {
  it("bounds mutation preflight queue wait without violating FIFO or leaking its lease", async () => {
    const coordinatedHost = await startCoordinatedHost({ snapshotBudgetMs: 60 });
    const cep = await connectSocket(coordinatedHost.port);
    await readyCep(cep);
    const queueOwner = await connectSocket(coordinatedHost.port);
    queueOwner.send(JSON.stringify({ kind: "dom_readiness_probe", requestId: "queue-owner", timeoutMs: 1_000 }));
    const occupied = await nextMessage(cep);
    expect(occupied.kind).toBe("dom_readiness_probe");

    const client = await connectClient(coordinatedHost.port);
    await expect(client.beginOperation({
      operationId: "preflight-queue-timeout", toolName: "add_marker", backend: "cep", mode: "mutate",
      timeoutMs: 1_000, queueDeadlineMs: 1_000,
    })).rejects.toMatchObject({ code: "HOST_PREFLIGHT_BLOCKED" });

    let skippedPreflightReachedCep = false;
    const observeUnexpected = (): void => { skippedPreflightReachedCep = true; };
    cep.once("message", observeUnexpected);
    cep.send(JSON.stringify({
      kind: "response", requestId: occupied.requestId, ok: true,
      data: { ok: true, projectOpen: true, projectName: "Project", activeSequence: null },
    }));
    expect(await nextMessage(queueOwner)).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    cep.off("message", observeUnexpected);
    expect(skippedPreflightReachedCep).toBe(false);

    const failedEntries = await operationLedger!.readEntries();
    expect(failedEntries.at(-1)).toMatchObject({
      operationId: "preflight-queue-timeout", status: "FAILED", errorCode: "HOST_PREFLIGHT_BLOCKED",
    });
    expect(await client.operationStatus()).toMatchObject({ quarantine: false, unresolved: [], queue: { mutationDepth: 0 } });

    const later = client.beginOperation({
      operationId: "mutation-after-preflight-timeout", toolName: "add_marker", backend: "cep", mode: "mutate",
      timeoutMs: 1_000, queueDeadlineMs: 1_000,
    });
    await answerNextCep(cep, JSON.stringify({ project: { name: "Project" }, activeSequence: { name: "CUT", sequenceID: "SEQ" }, targetSequence: { name: "CUT", sequenceID: "SEQ" } }));
    await expect(later).resolves.toBe("mutation-after-preflight-timeout");
    await expect(client.endOperation("mutation-after-preflight-timeout", "FAILED", "TEST_DONE")).resolves.toBe("FAILED");
  });

  it("finalizes an orphan read as FAILED after its owner disconnects", async () => {
    const coordinatedHost = await startCoordinatedHost();
    const cep = await connectSocket(coordinatedHost.port);
    await readyCep(cep);
    const owner = await connectSocket(coordinatedHost.port);
    owner.send(JSON.stringify({
      kind: "begin_operation", requestId: "begin-orphan-read", operationId: "orphan-read",
      toolName: "list_markers", backend: "cep", mode: "read", timeoutMs: 1_000, queueDeadlineMs: 1_000,
    }));
    expect(await nextMessage(owner)).toMatchObject({ ok: true, data: { operationId: "orphan-read" } });
    owner.terminate();

    const entries = await waitFor(
      async () => await operationLedger!.readEntries(),
      (items) => items.some((item) => item.operationId === "orphan-read" && item.status === "FAILED"),
    );
    expect(entries.at(-1)).toMatchObject({ operationId: "orphan-read", mode: "read", status: "FAILED", errorCode: "SOURCE_DISCONNECTED" });

    const nextOwner = await connectClient(coordinatedHost.port);
    await expect(nextOwner.beginOperation({
      operationId: "read-after-orphan", toolName: "list_markers", backend: "cep", mode: "read",
      timeoutMs: 1_000, queueDeadlineMs: 1_000,
    })).resolves.toBe("read-after-orphan");
    await expect(nextOwner.endOperation("read-after-orphan", "FAILED", "TEST_DONE")).resolves.toBe("FAILED");
  });

  it("quarantines a mutation whose owner disconnects while begin preflight is completing", async () => {
    const coordinatedHost = await startCoordinatedHost();
    const cep = await connectSocket(coordinatedHost.port);
    await readyCep(cep);
    const owner = await connectSocket(coordinatedHost.port);
    owner.send(JSON.stringify({
      kind: "begin_operation", requestId: "begin-orphan-mutation", operationId: "orphan-mutation",
      toolName: "add_marker", backend: "cep", mode: "mutate", timeoutMs: 1_000, queueDeadlineMs: 1_000,
    }));
    const preflight = await nextMessage(cep);
    owner.terminate();
    cep.send(JSON.stringify({
      kind: "response", requestId: preflight.requestId, ok: true,
      data: JSON.stringify({ project: { name: "Project" }, activeSequence: { name: "CUT", sequenceID: "SEQ" }, targetSequence: { name: "CUT", sequenceID: "SEQ" } }),
    }));

    const entries = await waitFor(
      async () => await operationLedger!.readEntries(),
      (items) => items.some((item) => item.operationId === "orphan-mutation" && item.status === "UNKNOWN"),
    );
    expect(entries.at(-1)).toMatchObject({ operationId: "orphan-mutation", mode: "mutate", status: "UNKNOWN", errorCode: "SOURCE_DISCONNECTED" });

    const observer = await connectClient(coordinatedHost.port);
    const status = await observer.operationStatus();
    expect(status).toMatchObject({
      quarantine: true,
      unresolved: [{ operationId: "orphan-mutation" }],
      queue: { mutationDepth: 1 },
    });
    await expect(observer.beginOperation({
      operationId: "blocked-after-orphan", toolName: "add_marker", backend: "cep", mode: "mutate",
      timeoutMs: 1_000, queueDeadlineMs: 50,
    })).rejects.toMatchObject({ code: "MUTATIONS_QUARANTINED" });
  });

  it("allows a delayed bounded mutation postflight to complete", async () => {
    const coordinatedHost = await startCoordinatedHost();
    const cep = await connectSocket(coordinatedHost.port);
    await readyCep(cep);
    const client = await connectClient(coordinatedHost.port);
    const begin = client.beginOperation({
      operationId: "delayed-postflight", toolName: "add_marker", backend: "cep", mode: "mutate",
      timeoutMs: 1_000, queueDeadlineMs: 1_000,
    });
    await answerNextCep(cep, JSON.stringify({ project: { name: "Project" }, activeSequence: { name: "CUT", sequenceID: "SEQ" }, targetSequence: { name: "CUT", sequenceID: "SEQ" } }));
    await begin;
    const end = client.endOperation("delayed-postflight", "SUCCEEDED");
    const postflight = await nextMessage(cep);
    await new Promise((resolve) => setTimeout(resolve, 100));
    cep.send(JSON.stringify({
      kind: "response", requestId: postflight.requestId, ok: true,
      data: JSON.stringify({ project: { name: "Project" }, activeSequence: { name: "CUT", sequenceID: "SEQ" }, targetSequence: { name: "CUT", sequenceID: "SEQ" } }),
    }));
    await expect(end).resolves.toBe("SUCCEEDED");
  });

  it("does not capture a mutation postflight when a read operation succeeds", async () => {
    const coordinatedHost = await startCoordinatedHost();
    const cep = await connectSocket(coordinatedHost.port);
    await readyCep(cep);
    const client = await connectClient(coordinatedHost.port);

    await expect(client.beginOperation({
      operationId: "read-no-postflight", toolName: "list_markers", backend: "cep", mode: "read",
      timeoutMs: 1_000, queueDeadlineMs: 1_000,
    })).resolves.toBe("read-no-postflight");
    const execution = client.executeScript("return 1;", 1_000, {
      operationId: "read-no-postflight", toolName: "list_markers", backend: "cep", mode: "read",
    });
    const request = await nextMessage(cep);
    cep.send(JSON.stringify({ kind: "response", requestId: request.requestId, ok: true, data: "read-ok" }));
    await expect(execution).resolves.toBe("read-ok");

    let unexpectedPostflight = false;
    const onCepMessage = (): void => { unexpectedPostflight = true; };
    cep.on("message", onCepMessage);
    await expect(client.endOperation("read-no-postflight", "SUCCEEDED")).resolves.toBe("SUCCEEDED");
    await new Promise((resolve) => setTimeout(resolve, 30));
    cep.off("message", onCepMessage);
    expect(unexpectedPostflight).toBe(false);
    expect((await operationLedger!.readEntries()).at(-1)).toMatchObject({ operationId: "read-no-postflight", mode: "read", status: "SUCCEEDED" });
  });

  it("serializes legacy CEP work across independent MCP clients", async () => {
    host = await WsHost.start(0, { heartbeatMs: 0 });
    const cep = await connectSocket(host.port);
    await readyCep(cep);
    const firstClient = await connectSocket(host.port);
    const secondClient = await connectSocket(host.port);

    firstClient.send(JSON.stringify({ kind: "execute", requestId: "first", script: "return 1;", timeoutMs: 1_000 }));
    const firstAtCep = await nextMessage(cep);
    secondClient.send(JSON.stringify({ kind: "execute", requestId: "second", script: "return 2;", timeoutMs: 1_000 }));
    let secondArrived = false;
    const observeSecond = nextMessage(cep).then((message) => { secondArrived = true; return message; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondArrived).toBe(false);

    cep.send(JSON.stringify({ kind: "response", requestId: firstAtCep.requestId, ok: true, data: 1 }));
    expect(await nextMessage(firstClient)).toMatchObject({ ok: true, data: 1 });
    const secondAtCep = await observeSecond;
    cep.send(JSON.stringify({ kind: "response", requestId: secondAtCep.requestId, ok: true, data: 2 }));
    expect(await nextMessage(secondClient)).toMatchObject({ ok: true, data: 2 });
  });

  it("rejects untagged host execution when the durable coordinator is enabled", async () => {
    const coordinatedHost = await startCoordinatedHost();
    const cep = await connectSocket(coordinatedHost.port);
    await readyCep(cep);
    const rawClient = await connectSocket(coordinatedHost.port);

    rawClient.send(JSON.stringify({ kind: "execute", requestId: "untagged", script: "return 1;", timeoutMs: 1_000 }));
    expect(await nextMessage(rawClient)).toMatchObject({ ok: false, error: { code: "COORDINATED_OPERATION_REQUIRED" } });
    let reachedCep = false;
    cep.once("message", () => { reachedCep = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reachedCep).toBe(false);
  });

  it("holds one mutation lease across tagged UXP and CEP subrequests", async () => {
    const coordinatedHost = await startCoordinatedHost();
    const cep = await connectSocket(coordinatedHost.port);
    await readyCep(cep);
    coordinatedHost.setUxpBridge({
      connected: true,
      dispatch: async () => ({ success: true, data: "uxp-ok" }),
    } as unknown as UxpBridgeHost);
    const client = await connectClient(coordinatedHost.port);

    const begin = client.beginOperation({ operationId: "mixed", toolName: "add_marker", backend: "uxp", mode: "mutate", timeoutMs: 1_000, queueDeadlineMs: 1_000 });
    expect((await answerNextCep(cep, "STATE-A")).kind).toBe("execute");
    expect(await begin).toBe("mixed");

    const rawClient = await connectSocket(coordinatedHost.port);
    rawClient.send(JSON.stringify({
      kind: "execute", requestId: "bad-script-metadata", script: "return 0;", timeoutMs: 1_000,
      operation: { operationId: "mixed", toolName: "add_marker", backend: "cep", mode: "mutate", scriptBytes: 999, scriptSha256: "0".repeat(64) },
    }));
    expect(await nextMessage(rawClient)).toMatchObject({ ok: false, error: { code: "SCRIPT_METADATA_MISMATCH" } });

    const uxp = client.uxp("marker.add", {}, undefined, { operationId: "mixed", toolName: "add_marker", backend: "uxp", mode: "mutate" }, 1_000);
    const cepExecution = client.executeScript("return 1;", 1_000, { operationId: "mixed", toolName: "add_marker", backend: "cep", mode: "mutate" });
    const cepRequest = await nextMessage(cep);
    cep.send(JSON.stringify({ kind: "response", requestId: cepRequest.requestId, ok: true, data: "cep-ok" }));
    await expect(Promise.all([uxp, cepExecution])).resolves.toEqual(["uxp-ok", "cep-ok"]);

    const competitor = client.beginOperation({ operationId: "competitor", toolName: "add_marker", backend: "cep", mode: "mutate", timeoutMs: 1_000, queueDeadlineMs: 20 });
    await expect(competitor).rejects.toThrow(/expired while waiting/);
    const end = client.endOperation("mixed", "SUCCEEDED");
    await answerNextCep(cep, "STATE-B");
    await expect(end).resolves.toBe("SUCCEEDED");
  });

  it("pins clip-targeted CEP mutations to the sequence resolved during preflight", async () => {
    const coordinatedHost = await startCoordinatedHost();
    const cep = await connectSocket(coordinatedHost.port);
    await readyCep(cep);
    const client = await connectClient(coordinatedHost.port);

    const pinnedState = JSON.stringify({
      project: { name: "Project" },
      activeSequence: { name: "CUT_A", sequenceID: "SEQ_A" },
      targetSequence: { name: "CUT_A", sequenceID: "SEQ_A" },
    });
    const begin = client.beginOperation({
      operationId: "clip-pinned", toolName: "move_clip", backend: "cep", mode: "mutate",
      targetHint: "clip-node-1", targetKind: "clip", timeoutMs: 1_000, queueDeadlineMs: 1_000,
    });
    await answerNextCep(cep, pinnedState);
    await expect(begin).resolves.toBe("clip-pinned");

    const execution = client.executeScript("return 1;", 1_000, {
      operationId: "clip-pinned", toolName: "move_clip", backend: "cep", mode: "mutate",
    });
    const identityCheck = await answerNextCep(cep, pinnedState);
    expect(String(identityCheck.script)).toContain('var targetHint = "SEQ_A"');
    const guarded = await nextMessage(cep);
    expect(String(guarded.script)).toContain('String(__active.sequenceID) !== "SEQ_A"');
    cep.send(JSON.stringify({ kind: "response", requestId: guarded.requestId, ok: true, data: "ok" }));
    await expect(execution).resolves.toBe("ok");
    await expect(client.endOperation("clip-pinned", "FAILED", "TEST_ONLY")).resolves.toBe("FAILED");
  });

  it("keeps generated recovery projections host-read bounded", async () => {
    const coordinatedHost = await startCoordinatedHost();
    const cep = await connectSocket(coordinatedHost.port);
    await readyCep(cep);
    const client = await connectClient(coordinatedHost.port);

    const begin = client.beginOperation({
      operationId: "bounded-projection", toolName: "set_keyframe_interpolation", backend: "cep", mode: "mutate",
      targetHint: "active-sequence", targetKind: "sequence", timeoutMs: 1_000, queueDeadlineMs: 1_000,
    });
    const snapshotRequest = await nextMessage(cep);
    const script = String(snapshotRequest.script);
    expect(script).toContain("var includeComponents = true");
    expect(script).toContain("MAX_PROPERTIES_TOTAL = 256");
    expect(script).toContain("sequence.getSettings()");
    expect(script).toContain("Math.min(childCount, remaining)");
    expect(script).not.toContain(".getKeys(");
    expect(script).not.toContain("JSON.stringify");
    const unusual = "rich\" slash\\ controls\n\t\u0002";
    const sequence = {
      name: unusual,
      sequenceID: unusual,
      end: { ticks: "508032000000", seconds: 2 },
      zeroPoint: "0",
      getSettings: () => ({ maximumBitDepth: true }),
      videoTracks: { numTracks: 0 },
      audioTracks: { numTracks: 0 },
    };
    const richSerialized = runInNewContext(script, {
      JSON: undefined,
      app: {
        project: {
          name: unusual,
          path: unusual,
          documentID: unusual,
          activeSequence: sequence,
          sequences: { 0: sequence, numSequences: 1 },
          rootItem: null,
        },
      },
    }) as string;
    expect(JSON.parse(richSerialized)).toMatchObject({
      project: { name: unusual, path: unusual, documentID: unusual },
      targetState: {
        name: unusual,
        settings: { maximumBitDepth: true },
        clips: [],
        componentCoverage: { capturedClipCount: 0 },
      },
    });
    cep.send(JSON.stringify({
      kind: "response", requestId: snapshotRequest.requestId, ok: true,
      data: JSON.stringify({ project: { name: "Project" }, activeSequence: { name: "CUT", sequenceID: "SEQ" }, targetSequence: { name: "CUT", sequenceID: "SEQ" } }),
    }));
    await expect(begin).resolves.toBe("bounded-projection");
    await expect(client.endOperation("bounded-projection", "FAILED", "TEST_ONLY")).resolves.toBe("FAILED");
  });

  it("uses a compact snapshot before and after execute_extendscript dispatch", async () => {
    const coordinatedHost = await startCoordinatedHost();
    const cep = await connectSocket(coordinatedHost.port);
    await readyCep(cep);
    const client = await connectClient(coordinatedHost.port);
    const compactState = JSON.stringify({
      project: { name: "Project", path: "project.prproj" },
      projectState: { name: "Project", path: "project.prproj" },
      activeSequence: { name: "CUT", sequenceID: "SEQ", endSeconds: 1 },
      targetSequence: { name: "CUT", sequenceID: "SEQ", endSeconds: 1 },
      targetState: { name: "CUT", sequenceID: "SEQ", endSeconds: 1 },
      coverage: "project",
    });

    const callerSource = "return __result({ok:true});";
    const begin = client.beginOperation({
      operationId: "raw-compact", toolName: "execute_extendscript", backend: "cep", mode: "mutate",
      targetHint: "active-project", targetKind: "project", timeoutMs: 1_000, queueDeadlineMs: 1_000,
      args: { code: callerSource }, itemCount: 1, estimatedRiskyCalls: 0,
    });
    const preflight = await nextMessage(cep);
    const preflightScript = String(preflight.script);
    expect(Buffer.byteLength(preflightScript, "utf8")).toBeLessThan(4_096);
    expect(preflightScript).toContain("var sequenceState = active");
    expect(preflightScript).not.toContain("captureProject");
    expect(preflightScript).not.toContain("captureComponents");
    expect(preflightScript).not.toContain("documentID");
    expect(preflightScript).not.toContain("ticks");
    expect(preflightScript).not.toContain("end: (function");
    expect(preflightScript).not.toContain("JSON.stringify");
    const unusual = "quote\" slash\\ controls\b\f\n\r\t\u0001";
    const locallySerialized = runInNewContext(preflightScript, {
      JSON: undefined,
      app: {
        project: {
          name: unusual,
          path: unusual,
          activeSequence: { name: unusual, sequenceID: unusual, end: { seconds: 1.25 } },
        },
      },
    }) as string;
    expect(JSON.parse(locallySerialized)).toMatchObject({
      projectState: { name: unusual, path: unusual },
      targetState: { name: unusual, sequenceID: unusual, endSeconds: 1.25 },
    });
    cep.send(JSON.stringify({ kind: "response", requestId: preflight.requestId, ok: true, data: compactState }));
    await expect(begin).resolves.toBe("raw-compact");

    const execution = client.executeScript(buildToolScript(callerSource), 1_000, {
      operationId: "raw-compact", toolName: "execute_extendscript", backend: "cep", mode: "mutate",
    });
    const identityCheck = await answerNextCep(cep, compactState);
    expect(String(identityCheck.script)).toBe(preflightScript);
    const rawRequest = await nextMessage(cep);
    expect(String(rawRequest.script)).toContain(callerSource);
    expect(String(rawRequest.script)).not.toContain("var sequenceState = active");
    cep.send(JSON.stringify({ kind: "response", requestId: rawRequest.requestId, ok: true, data: "ok" }));
    await expect(execution).resolves.toBe("ok");

    const end = client.endOperation("raw-compact", "SUCCEEDED");
    const postflight = await nextMessage(cep);
    expect(String(postflight.script)).toBe(preflightScript);
    cep.send(JSON.stringify({ kind: "response", requestId: postflight.requestId, ok: true, data: compactState }));
    await expect(end).resolves.toBe("SUCCEEDED");

    const final = (await operationLedger!.readEntries()).at(-1);
    expect(final).toMatchObject({
      operationId: "raw-compact", status: "SUCCEEDED",
      preSnapshot: { coverage: "project", resolvedSequenceId: "SEQ" },
      postSnapshot: { coverage: "project", resolvedSequenceId: "SEQ" },
    });
  });

  it("does not dispatch execute_extendscript after compact preflight failure", async () => {
    const coordinatedHost = await startCoordinatedHost();
    const cep = await connectSocket(coordinatedHost.port);
    await readyCep(cep);
    const client = await connectClient(coordinatedHost.port);

    const begin = client.beginOperation({
      operationId: "raw-preflight-failed", toolName: "execute_extendscript", backend: "cep", mode: "mutate",
      targetHint: "active-project", targetKind: "project", timeoutMs: 1_000, queueDeadlineMs: 1_000,
      args: { code: "return __result({ok:true});" }, itemCount: 1, estimatedRiskyCalls: 0,
    });
    const preflight = await nextMessage(cep);
    expect(String(preflight.script)).not.toContain("captureProject");
    cep.send(JSON.stringify({
      kind: "response", requestId: preflight.requestId, ok: false,
      error: { code: "EXTENDSCRIPT_ERROR", message: "EvalScript error." },
    }));
    await expect(begin).rejects.toMatchObject({ code: "EXTENDSCRIPT_ERROR" });

    let reachedCep = false;
    cep.once("message", () => { reachedCep = true; });
    await expect(client.executeScript("return 1;", 1_000, {
      operationId: "raw-preflight-failed", toolName: "execute_extendscript", backend: "cep", mode: "mutate",
    })).rejects.toThrow(/not active/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reachedCep).toBe(false);
    expect((await operationLedger!.readEntries()).at(-1)).toMatchObject({
      operationId: "raw-preflight-failed", status: "FAILED", errorCode: "EXTENDSCRIPT_ERROR",
    });
  });

  it("quarantines timeout, compares reconnect state, and acknowledges only the observed fingerprint", async () => {
    const coordinatedHost = await startCoordinatedHost();
    const cep1 = await connectSocket(coordinatedHost.port);
    await readyCep(cep1);
    const client = await connectClient(coordinatedHost.port);

    const boundedTargetState = { name: "CUT_02", sequenceID: "SEQ_02", end: 120, settings: { videoFrameRate: 23.976 }, clips: [{ nodeId: "clip-A", start: 0, end: 120 }] };
    const statePayload = JSON.stringify({ project: { name: "Project" }, activeSequence: { name: "ACTIVE_OTHER" }, targetSequence: { name: "CUT_02", sequenceID: "SEQ_02" }, targetState: boundedTargetState, coverage: "timeline" });
    const begin = client.beginOperation({
      operationId: "unknown-op", toolName: "add_marker", backend: "cep", mode: "mutate",
      targetHint: "CUT_02", targetKind: "sequence", timeoutMs: 250, queueDeadlineMs: 1_000,
    });
    const preflightRequest = await answerNextCep(cep1, statePayload);
    expect(String(preflightRequest.script)).toContain('var targetHint = "CUT_02"');
    await begin;
    const running = (await operationLedger!.readEntries()).at(-1);
    expect(running?.preSnapshot).toMatchObject({
      projectHash: payloadMetadata({ name: "Project" }).sha256,
      sequenceHash: payloadMetadata(boundedTargetState).sha256,
      coverage: "timeline",
    });
    const execution = client.executeScript("return 1;", 250, { operationId: "unknown-op", toolName: "add_marker", backend: "cep", mode: "mutate" });
    await answerNextCep(cep1, statePayload);
    const timedOutRequest = await nextMessage(cep1);
    await expect(execution).rejects.toMatchObject({ outcomeUnknown: true } satisfies Partial<BridgeExecutionError>);
    const lateCompletion = new Promise<Record<string, unknown>>((resolve) => {
      const unsubscribe = client.onLateCompletion((message) => { unsubscribe(); resolve(message as unknown as Record<string, unknown>); });
    });
    cep1.send(JSON.stringify({ kind: "late_completion", requestId: timedOutRequest.requestId, ok: true, data: "late-result" }));
    await expect(lateCompletion).resolves.toMatchObject({
      kind: "late_completion", data: "late-result", operation: { operationId: "unknown-op", toolName: "add_marker" },
    });
    expect(await client.operationStatus()).toMatchObject({ quarantine: true, modalState: "unknown", unresolved: [{ operationId: "unknown-op" }] });

    cep1.close();
    const cep2 = await connectSocket(coordinatedHost.port);
    const reconnectMessages = nextMessages(cep2, 2);
    cep2.send(JSON.stringify({
      kind: "ready",
      identity: testIdentity("recovery-reconnect-runtime"),
      premiereVersion: "26.3-reconnected",
    }));
    const [, reconnectSnapshot] = await reconnectMessages;
    const reconnectPayload = JSON.stringify({ project: { name: "Project" }, activeSequence: { name: "UNRELATED_OPEN_SEQUENCE" }, targetSequence: { name: "CUT_02", sequenceID: "SEQ_02" }, targetState: boundedTargetState, coverage: "timeline" });
    cep2.send(JSON.stringify({ kind: "response", requestId: reconnectSnapshot!.requestId, ok: true, data: reconnectPayload }));
    const targetFingerprint = payloadMetadata({ project: { name: "Project" }, targetState: boundedTargetState }).sha256;
    let status = await client.operationStatus();
    expect(status).toMatchObject({
      cep: { connected: true }, quarantine: true,
      reconciliation: [{ operationId: "unknown-op", state: "BOUNDED_MATCH", observedFingerprint: targetFingerprint }],
    });

    cep2.close();
    const cep3 = await connectSocket(coordinatedHost.port);
    const changedReconnectMessages = nextMessages(cep3, 2);
    cep3.send(JSON.stringify({
      kind: "ready",
      identity: testIdentity("recovery-settings-changed-runtime"),
      premiereVersion: "26.3-settings-changed",
    }));
    const [, changedSnapshot] = await changedReconnectMessages;
    const changedTargetState = { ...boundedTargetState, settings: { videoFrameRate: 29.97 } };
    const changedPayload = JSON.stringify({ project: { name: "Project" }, activeSequence: { name: "UNRELATED_OPEN_SEQUENCE" }, targetSequence: { name: "CUT_02", sequenceID: "SEQ_02" }, targetState: changedTargetState, coverage: "timeline" });
    cep3.send(JSON.stringify({ kind: "response", requestId: changedSnapshot!.requestId, ok: true, data: changedPayload }));
    const changedFingerprint = payloadMetadata({ project: { name: "Project" }, targetState: changedTargetState }).sha256;
    status = await client.operationStatus();
    expect(status).toMatchObject({
      quarantine: true,
      reconciliation: [{ operationId: "unknown-op", state: "CHANGED_FROM_PRE", observedFingerprint: changedFingerprint }],
    });

    const recoverySnapshot = client.recoverySnapshot("unknown-op");
    await answerNextCep(cep3, changedPayload);
    await expect(recoverySnapshot).resolves.toEqual({
      operationId: "unknown-op", observedFingerprint: changedFingerprint, projectionVersion: 2, comparison: "CHANGED_FROM_PRE",
    });
    status = await client.operationStatus();
    expect(status).toMatchObject({ quarantine: true, queue: { mutationDepth: 1 } });

    const expected = changedFingerprint;
    const goodAck = client.acknowledgeRecovery("unknown-op", expected);
    await answerNextCep(cep3, changedPayload);
    await expect(goodAck).resolves.toEqual({ operationId: "unknown-op", observedFingerprint: expected });
    expect(await client.operationStatus()).toMatchObject({ quarantine: false, unresolved: [], queue: { coordinatorCepDepth: 0, mutationDepth: 0 } });
  });
});
