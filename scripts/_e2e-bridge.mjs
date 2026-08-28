/**
 * End-to-end bridge check (no Premiere needed).
 *
 * Boots a real daemon (WsHost) on an ephemeral port, attaches a fake CEP
 * client that answers `execute` with a plausible ExtendScript JSON result,
 * then runs the real MCP server + BridgeClient + InMemory MCP client through
 * the actual WebSocket. This proves the full wire path (MCP -> daemon -> CEP
 * -> daemon -> MCP) works, not just that a mock transport returns data.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import WebSocket from "ws";
import { APPROVED_CEP_EXTENSION_ID, CEP_BRIDGE_PROTOCOL_VERSION } from "../dist/bridge-types.js";
import { WsHost } from "../dist/bridge/ws-host.js";
import { BridgeClient } from "../dist/bridge/ws-client.js";
import { createMcpServer } from "../dist/server.js";

const host = await WsHost.start(0);
const port = host.port;

// Fake CEP host client.
const cep = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
await new Promise((res) => cep.on("open", () => res()));
const receivedScripts = [];
cep.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.kind === "hello") return;
  if (msg.kind === "execute") {
    receivedScripts.push(String(msg.script || ""));
    // Simulate ExtendScript returning a JSON string (like __result does).
    const fakeResult = JSON.stringify({ success: true, data: { simulated: true, scriptLength: String(msg.script || "").length } });
    cep.send(JSON.stringify({ kind: "response", requestId: msg.requestId, ok: true, data: fakeResult }));
  }
});
cep.send(JSON.stringify({
  kind: "ready",
  identity: {
    extensionId: APPROVED_CEP_EXTENSION_ID,
    protocolVersion: CEP_BRIDGE_PROTOCOL_VERSION,
    bridgeVersion: "simulated-cep",
    instanceId: "e2e-simulated-runtime",
  },
  premiereVersion: "simulated-premiere",
}));
await new Promise((res) => setTimeout(res, 200));

// Real MCP server over the real bridge client.
const bridge = await BridgeClient.connect(port);
const server = createMcpServer(bridge);
const client = new Client({ name: "e2e", version: "1.0.0" });
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverT), client.connect(clientT)]);

// Call a few P0 tools end-to-end.
const result = await client.callTool({ name: "premiere_get_project_info", arguments: {} });
const text = result.content?.[0]?.text ?? "";
console.log("premiere_get_project_info ->", text.slice(0, 220));
console.log("scripts that reached the CEP host:", receivedScripts.length);
console.log("last script tail:", JSON.stringify(receivedScripts[receivedScripts.length - 1]?.slice(-50)));

const lastScript = receivedScripts[receivedScripts.length - 1] ?? "";
const wrapped = lastScript.startsWith("(function(){") && lastScript.endsWith("})();");
console.log("script is IIFE-wrapped (no top-level return leak)?", wrapped);
const ok = receivedScripts.length >= 1 && /simulated/.test(text) && wrapped;
console.log(ok ? "E2E PASS: full daemon<->CEP<->MCP wire path works" : "E2E FAIL");

await client.close();
await server.close();
await bridge.close();
host.close();
cep.close();
process.exit(ok ? 0 : 1);
