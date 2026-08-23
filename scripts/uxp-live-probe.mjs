import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const launcher = join(localAppData, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe");
const bundle = join(localAppData, "PremiereMCP", "bundle", "premiere-mcp.bundle.mjs");
const uxpPort = process.env.PREMIERE_MCP_UXP_PORT || "17777";
const client = new Client({ name: "premiere-mcp-uxp-live-probe", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: launcher,
  args: ["--launch-mcp", bundle],
  stderr: "pipe",
  env: { ...process.env, PREMIERE_MCP_UXP_PORT: uxpPort, PREMIERE_MCP_UI_PIPE: `PremiereMcpUi.UxpProbe.${process.pid}` },
});

function data(result) {
  assert.equal(result.isError, undefined);
  return result.structuredContent;
}

try {
  await client.connect(transport);
  const deadline = Date.now() + 40_000;
  let capabilities;
  while (Date.now() < deadline) {
    capabilities = data(await client.callTool({ name: "premiere_capabilities", arguments: {} }, undefined, { timeout: 10_000 }));
    if (capabilities.backends?.uxp?.available) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.equal(capabilities?.backends?.uxp?.available, true, JSON.stringify(capabilities?.backends?.uxp));
  const catalog = data(await client.callTool({ name: "premiere_api", arguments: { actionId: "uxp.catalog", args: { query: "ProjectStatic.getActiveProject", offset: 0, limit: 10 } } }, undefined, { timeout: 15_000 }));
  assert.equal(catalog.status, "succeeded", JSON.stringify(catalog));
  process.stdout.write(`${JSON.stringify({ ok: true, uxp: capabilities.backends.uxp, catalog: catalog.data }, null, 2)}\n`);
} finally {
  await client.close();
}
