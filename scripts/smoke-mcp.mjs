import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const launcher = process.env.PREMIERE_MCP_SECRET_HELPER || join(localAppData, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe");
const bundle = process.env.PREMIERE_MCP_BUNDLE || join(localAppData, "PremiereMCP", "bundle", "premiere-mcp.bundle.mjs");
const client = new Client({ name: "premiere-mcp-smoke", version: "1.0.0" });
const childEnv = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined));
childEnv.PREMIERE_MCP_UXP_PORT = String(20_000 + (process.pid % 20_000));
childEnv.PREMIERE_MCP_UI_PIPE = `PremiereMcpUi.Smoke.${process.pid}`;
const transport = new StdioClientTransport({ command: launcher, args: ["--launch-mcp", bundle], cwd: root, env: childEnv, stderr: "pipe" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const expected of ["premiere_capabilities", "premiere_api", "premiere_inspect", "premiere_project", "premiere_timeline", "premiere_plugins", "premiere_cloud", "premiere_operations"]) {
    assert(names.has(expected), `Missing MCP tool ${expected}`);
  }

  const capabilities = await client.callTool({ name: "premiere_capabilities", arguments: {} });
  assert.equal(capabilities.isError, undefined);
  assert.equal(capabilities.structuredContent?.target?.version, "26.3.2");
  assert.equal(capabilities.structuredContent?.adobeUxpInventory?.counts?.members, 761);

  const apiCatalog = await client.callTool({ name: "premiere_api", arguments: { actionId: "uxp.catalog", args: { query: "Project", offset: 0, limit: 5 } } });
  assert.equal(apiCatalog.structuredContent?.status, "succeeded");
  assert.equal(apiCatalog.structuredContent?.backend, "local");
  assert.equal(apiCatalog.structuredContent?.data?.entries?.length, 5);

  const host = await client.callTool({ name: "premiere_inspect", arguments: { actionId: "host.inspect", args: {} } });
  if (host.structuredContent?.status !== "succeeded") {
    process.stderr.write(`${JSON.stringify({ smoke: "host.inspect", status: host.structuredContent?.status ?? null, backend: host.structuredContent?.backend ?? null, errorCode: host.structuredContent?.error?.code ?? null })}\n`);
  }
  assert.equal(host.structuredContent?.status, "succeeded");
  assert(["local", "cep", "uxp"].includes(host.structuredContent?.backend), "No valid host backend was selected");

  const plugins = await client.callTool({ name: "premiere_plugins", arguments: { actionId: "plugin.catalog", args: {} } });
  assert.equal(plugins.structuredContent?.status, "succeeded");
  assert(Number(plugins.structuredContent?.data?.counts?.total) > 0, "Local plugin inventory was empty");

  process.stdout.write(`${JSON.stringify({ ok: true, tools: tools.tools.length, targetVersion: capabilities.structuredContent.target.version, adobeUxpMembers: capabilities.structuredContent.adobeUxpInventory.counts.members, apiCatalogPage: apiCatalog.structuredContent.data.entries.length, localPluginCount: plugins.structuredContent.data.counts.total, selectedHostBackend: host.structuredContent.backend }, null, 2)}\n`);
} finally {
  await client.close();
}
