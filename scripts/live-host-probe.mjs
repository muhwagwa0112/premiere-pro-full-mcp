import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const launcher = process.env.PREMIERE_MCP_LAUNCHER || join(localAppData, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe");
const bundle = process.env.PREMIERE_MCP_BUNDLE || join(localAppData, "PremiereMCP", "bundle", "premiere-mcp.bundle.mjs");
const client = new Client({ name: "premiere-mcp-live-probe", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: launcher,
  args: ["--launch-mcp", bundle],
  cwd: root,
  stderr: "pipe",
  // A Codex Desktop MCP instance may already own the production UXP port.
  // This probe validates the independent CEP/QE/UI bridges without disturbing it.
  env: {
    ...process.env,
    PREMIERE_MCP_UXP_PORT: process.env.PREMIERE_MCP_PROBE_UXP_PORT || "17778",
    PREMIERE_MCP_UI_PIPE: process.env.PREMIERE_MCP_PROBE_UI_PIPE || `PremiereMcpUi.Probe.${process.pid}`,
  },
});

function data(result) {
  assert.equal(result.isError, undefined);
  return result.structuredContent;
}

async function call(name, actionId, args = {}) {
  process.stderr.write(`[live-host-probe] ${name}\n`);
  return data(await client.callTool(
    { name: actionId ? "premiere_api" : "premiere_capabilities", arguments: actionId ? { actionId, args } : {} },
    undefined,
    { timeout: 50_000, maxTotalTimeout: 50_000 },
  ));
}

try {
  await client.connect(transport);
  const capabilities = await call("capabilities");
  process.stderr.write("[live-host-probe] host.inspect\n");
  const host = data(await client.callTool({ name: "premiere_inspect", arguments: { actionId: "host.inspect", args: {} } }, undefined, { timeout: 50_000, maxTotalTimeout: 50_000 }));
  process.stderr.write("[live-host-probe] project.inspect\n");
  const project = data(await client.callTool({ name: "premiere_inspect", arguments: { actionId: "project.inspect", args: {} } }, undefined, { timeout: 50_000, maxTotalTimeout: 50_000 }));
  const appCatalog = await call("cep.surface.catalog", "cep.surface.catalog", { root: "app", query: "project", offset: 0, limit: 200 });
  const qeCatalog = await call("qe.catalog", "qe.catalog", { root: "qeProject", query: "effect", offset: 0, limit: 100 });
  const uiCatalog = await call("ui.catalog", "ui.catalog", { offset: 0, limit: 20 });

  if ([appCatalog, qeCatalog, uiCatalog].some((result) => result.status !== "succeeded")) {
    process.stderr.write(JSON.stringify({ appCatalog, qeCatalog, uiCatalog }, null, 2) + "\n");
  }

  assert.equal(host.status, "succeeded");
  assert.equal(host.backend, "cep");
  assert.equal(host.hostVersion, "26.3.2");
  assert.equal(appCatalog.status, "succeeded");
  assert.equal(qeCatalog.status, "succeeded");
  assert.equal(uiCatalog.status, "succeeded");

  process.stdout.write(JSON.stringify({
    ok: true,
    backends: capabilities.backends,
    host: { backend: host.backend, version: host.hostVersion, verification: host.verification, data: host.data },
    project: { status: project.status, data: project.data },
    appCapabilities: appCatalog.data,
    qeCapabilities: qeCatalog.data,
    uiControlCount: uiCatalog.data?.controls?.length ?? null,
  }, null, 2) + "\n");
} finally {
  await client.close();
}
