import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { UiNamedPipeAdapter } from "../src/bridge/ui-named-pipe.js";
import { effectiveBridgeRequestDigest, routeBindingFromProbe } from "../src/security/execution-plan.js";

const token = "routing-test-token-1234567890";
const servers: Array<ReturnType<typeof createServer>> = [];

function pipePath(name: string): string {
  return `\\\\.\\pipe\\${name}`;
}

function semanticArgs(): Record<string, unknown> {
  return {
    adapterId: "premiere.workspace.editing",
    adapterVersion: 1,
    hostBuild: "26.3.2.1",
    locale: "ko-KR",
    uiFingerprint: `sha256:${"d".repeat(64)}`,
  };
}

async function listen(mode: "disconnect" | "hang"): Promise<{ adapter: UiNamedPipeAdapter }> {
  const name = `PremiereMcpRouting-${randomUUID()}`;
  const server = createServer((socket: Socket) => {
    socket.once("data", () => {
      if (mode === "disconnect") socket.destroy();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath(name), resolve);
  });
  return { adapter: new UiNamedPipeAdapter(token, name, 50) };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("UI dispatch-state classification", () => {
  it("classifies a pre-send connection failure as not_dispatched", async () => {
    const adapter = new UiNamedPipeAdapter(token, `PremiereMcpMissing-${randomUUID()}`, 50);
    const response = await adapter.execute({ protocolVersion: 1, requestId: randomUUID(), operation: "ui.adapter.invoke", args: semanticArgs() });
    expect(response).toMatchObject({ ok: false, dispatchState: "not_dispatched", error: { code: "UI_UNAVAILABLE" } });
  });

  it("classifies connection loss after request write as non-retryable unknown", async () => {
    const { adapter } = await listen("disconnect");
    const response = await adapter.execute({ protocolVersion: 1, requestId: randomUUID(), operation: "ui.adapter.invoke", args: semanticArgs() });
    expect(response).toMatchObject({ ok: false, dispatchState: "unknown", error: { code: "UI_DISCONNECTED", retryable: false } });
  });

  it("classifies a timeout after request write as non-retryable unknown", async () => {
    const { adapter } = await listen("hang");
    const response = await adapter.execute({ protocolVersion: 1, requestId: randomUUID(), operation: "ui.adapter.invoke", args: semanticArgs() });
    expect(response).toMatchObject({ ok: false, dispatchState: "unknown", error: { code: "UI_TIMEOUT", retryable: false } });
  });

  it("does not send a mutation when the agent restarts after planning", async () => {
    const name = `PremiereMcpRouteDrift-${randomUUID()}`;
    let healthCalls = 0;
    let mutationCalls = 0;
    const server = createServer((socket: Socket) => {
      socket.once("data", (chunk) => {
        const request = JSON.parse(chunk.toString("utf8")) as { requestId: string; operation: string };
        if (request.operation === "health") {
          healthCalls++;
          const session = healthCalls === 1 ? "agent-session-a" : "agent-session-b";
          socket.end(`${JSON.stringify({ protocolVersion: 1, requestId: request.requestId, ok: true, result: { status: "ok", agent: "premiere-mcp-windows-ui", protocolVersion: 1, agentVersion: "1.0.0", agentSessionId: session, capabilityFingerprint: "a".repeat(64), semanticAdapterProtocol: 1 } })}\n`);
          return;
        }
        mutationCalls++;
        socket.end(`${JSON.stringify({ protocolVersion: 1, requestId: request.requestId, ok: true, result: {} })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipePath(name), resolve); });
    const adapter = new UiNamedPipeAdapter(token, name, 50);
    const plannedProbe = await adapter.probe();

    const response = await adapter.execute({ protocolVersion: 1, requestId: randomUUID(), operation: "ui.adapter.invoke", args: semanticArgs(), routeBinding: routeBindingFromProbe(plannedProbe), planHash: `sha256:${"a".repeat(64)}` });

    expect(response).toMatchObject({ ok: false, dispatchState: "not_dispatched", error: { code: "ROUTE_BINDING_DRIFT" } });
    expect(mutationCalls).toBe(0);
  });

  it("forwards the planned route binding and hash to a stable UI agent", async () => {
    const name = `PremiereMcpRouteBinding-${randomUUID()}`;
    let received: Record<string, unknown> | undefined;
    const server = createServer((socket: Socket) => {
      socket.once("data", (chunk) => {
        const request = JSON.parse(chunk.toString("utf8")) as Record<string, unknown>;
        if (request.operation === "health") {
          socket.end(`${JSON.stringify({ protocolVersion: 1, requestId: request.requestId, ok: true, result: { status: "ok", agent: "premiere-mcp-windows-ui", protocolVersion: 1, agentVersion: "1.0.0", agentSessionId: "agent-session-a", capabilityFingerprint: "b".repeat(64), semanticAdapterProtocol: 1 } })}\n`);
          return;
        }
        received = request;
        socket.end(`${JSON.stringify({ protocolVersion: 1, requestId: request.requestId, ok: true, result: { invoked: true, postcondition: { verified: true, method: "selection-item-is-selected" } } })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipePath(name), resolve); });
    const adapter = new UiNamedPipeAdapter(token, name, 50);
    const plannedProbe = await adapter.probe();
    const planHash = `sha256:${"c".repeat(64)}`;

    const args = semanticArgs();
    const response = await adapter.execute({ protocolVersion: 1, requestId: randomUUID(), operation: "ui.adapter.invoke", args, routeBinding: routeBindingFromProbe(plannedProbe), planHash, effectiveRequestDigest: effectiveBridgeRequestDigest("ui.adapter.invoke", args) });

    expect(response.ok).toBe(true);
    expect(received).toMatchObject({ planHash, routeBinding: routeBindingFromProbe(plannedProbe) });
  });

  it("fails closed after dispatch when adapter postcondition evidence is missing", async () => {
    const name = `PremiereMcpPostcondition-${randomUUID()}`;
    const server = createServer((socket: Socket) => {
      socket.once("data", (chunk) => {
        const request = JSON.parse(chunk.toString("utf8")) as Record<string, unknown>;
        if (request.operation === "health") {
          socket.end(`${JSON.stringify({ protocolVersion: 1, requestId: request.requestId, ok: true, result: { status: "ok", agent: "premiere-mcp-windows-ui", protocolVersion: 1, agentVersion: "1.0.0", agentSessionId: "agent-session-a", capabilityFingerprint: "e".repeat(64), semanticAdapterProtocol: 1 } })}\n`);
          return;
        }
        socket.end(`${JSON.stringify({ protocolVersion: 1, requestId: request.requestId, ok: true, result: { invoked: true } })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipePath(name), resolve); });
    const adapter = new UiNamedPipeAdapter(token, name, 50);
    const plannedProbe = await adapter.probe();
    const args = semanticArgs();

    const response = await adapter.execute({
      protocolVersion: 1,
      requestId: randomUUID(),
      operation: "ui.adapter.invoke",
      args,
      routeBinding: routeBindingFromProbe(plannedProbe),
      planHash: `sha256:${"f".repeat(64)}`,
      effectiveRequestDigest: effectiveBridgeRequestDigest("ui.adapter.invoke", args),
    });

    expect(response).toMatchObject({
      ok: false,
      dispatchState: "unknown",
      error: { code: "UI_POSTCONDITION_NOT_VERIFIED", retryable: false },
    });
  });

  it("normalizes an agent postcondition failure as an unknown non-retryable outcome", async () => {
    const name = `PremiereMcpPostconditionFailure-${randomUUID()}`;
    const server = createServer((socket: Socket) => {
      socket.once("data", (chunk) => {
        const request = JSON.parse(chunk.toString("utf8")) as Record<string, unknown>;
        if (request.operation === "health") {
          socket.end(`${JSON.stringify({ protocolVersion: 1, requestId: request.requestId, ok: true, result: { status: "ok", agent: "premiere-mcp-windows-ui", protocolVersion: 1, agentVersion: "1.0.0", agentSessionId: "agent-session-a", capabilityFingerprint: "9".repeat(64), semanticAdapterProtocol: 1 } })}\n`);
          return;
        }
        socket.end(`${JSON.stringify({ protocolVersion: 1, requestId: request.requestId, ok: false, error: { code: "ui_postcondition_failed", message: "not verified", retryable: false } })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipePath(name), resolve); });
    const adapter = new UiNamedPipeAdapter(token, name, 50);
    const plannedProbe = await adapter.probe();
    const args = semanticArgs();

    const response = await adapter.execute({
      protocolVersion: 1,
      requestId: randomUUID(),
      operation: "ui.adapter.invoke",
      args,
      routeBinding: routeBindingFromProbe(plannedProbe),
      planHash: `sha256:${"8".repeat(64)}`,
      effectiveRequestDigest: effectiveBridgeRequestDigest("ui.adapter.invoke", args),
    });

    expect(response).toMatchObject({ ok: false, dispatchState: "unknown", error: { code: "UI_POSTCONDITION_NOT_VERIFIED", retryable: false } });
  });
});
