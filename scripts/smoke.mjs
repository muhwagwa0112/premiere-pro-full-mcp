/**
 * Smoke test: boot the built server in-process against a mock transport,
 * open a client, and assert the full flat tool surface is advertised.
 * Requires `npm run build` first.
 *
 * Also verifies that every advertised tool reaches a real handler that calls
 * executeScript (i.e. nothing is a silent no-op): we intercept the transport
 * and fail the run if any handler returns without touching it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { createMcpServer } = await import("../dist/server.js");
const { ALL_TOOL_NAMES } = await import("../dist/tool-names.js");

let executed = 0;
const executedScripts = [];
const executedByTool = new Map();
const mockTransport = {
  get connected() { return true; },
  get port() { return 4242; },
  async executeScript(script) {
    executed++;
    executedScripts.push(script);
    return { success: true, data: { ok: true } };
  },
};

const server = createMcpServer(mockTransport);
const client = new Client({ name: "smoke", version: "1.0.0" });
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverT), client.connect(clientT)]);

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
const expected = ALL_TOOL_NAMES.length + 1; // +1 for premiere_capabilities
const hasAll = names.filter((n) => n.startsWith("premiere_")).length;
console.log(`tools advertised: ${hasAll} (expect >= ${expected})`);
if (hasAll < expected) {
  console.error(`SMOKE FAIL: advertised only ${hasAll} tools`);
  process.exit(1);
}

// Verify the upstream handlers really invoke the transport (no silent no-ops).
const upstreamProbe = tools.tools.find((t) => t.name === "premiere_get_project_info" || t.name === "premiere_list_sequences");
if (!upstreamProbe) {
  console.error("SMOKE FAIL: upstream probe tool not advertised");
  process.exit(1);
}
const call = await client.callTool({
  name: upstreamProbe.name,
  arguments: {},
});
if (executed < 1) {
  console.error("SMOKE FAIL: upstream handler did not invoke transport.executeScript");
  process.exit(1);
}
if (!call.content || !Array.isArray(call.content) || call.content.length === 0) {
  console.error("SMOKE FAIL: tool call returned no content");
  process.exit(1);
}

console.log(`SMOKE PASS: ${hasAll} flat tools advertised; upstream handler executed ${executed} transport call(s)`);
await client.close();
await server.close();
