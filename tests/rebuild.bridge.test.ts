import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { APPROVED_CEP_EXTENSION_ID, CEP_BRIDGE_PROTOCOL_VERSION } from "../src/bridge-types.js";
import { WsHost } from "../src/bridge/ws-host.js";

let host: WsHost | null = null;
afterEach(async () => { if (host) { await host.close(); host = null; } });

describe("bridge WebSocket host", () => {
  it("writes an endpoint file, accepts a CEP host, and relays an execute/response", async () => {
    host = await WsHost.start(0);
    const port = host.port;
    expect(port).toBeGreaterThan(0);

    // 1. A "CEP host" client connects, announces ready, and answers executes.
    const cepWs = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    await new Promise<void>((resolve) => cepWs.on("open", () => resolve()));
    cepWs.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.kind === "execute") {
        cepWs.send(JSON.stringify({ kind: "response", requestId: msg.requestId, ok: true, data: "{\"pong\":true}" }));
      }
    });
    cepWs.send(JSON.stringify({
      kind: "ready",
      identity: {
        extensionId: APPROVED_CEP_EXTENSION_ID,
        protocolVersion: CEP_BRIDGE_PROTOCOL_VERSION,
        bridgeVersion: "test",
        instanceId: "rebuild-test-runtime",
      },
      premiereVersion: "test",
    }));

    // 2. An MCP client connects as a second client and issues an execute.
    const mcpWs = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    await new Promise<void>((resolve) => mcpWs.on("open", () => resolve()));

    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 3000);
      mcpWs.once("message", (raw) => {
        clearTimeout(timer);
        resolve(JSON.parse(raw.toString()));
      });
      mcpWs.send(JSON.stringify({ kind: "execute", requestId: "abc", script: "return 1;" }));
    });

    expect(reply).toEqual({ kind: "response", requestId: "abc", ok: true, data: "{\"pong\":true}" });
    mcpWs.close();
    cepWs.close();
  });
});
