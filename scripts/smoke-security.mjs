import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const launcher = process.env.PREMIERE_MCP_SECRET_HELPER || join(localAppData, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe");
const bundle = process.env.PREMIERE_MCP_BUNDLE || join(localAppData, "PremiereMCP", "bundle", "premiere-mcp.bundle.mjs");
const client = new Client({ name: "premiere-mcp-security-smoke", version: "1.0.0" });
const childEnv = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined));
childEnv.PREMIERE_MCP_UXP_PORT = process.env.PREMIERE_MCP_SECURITY_SMOKE_UXP_PORT || "17777";
childEnv.PREMIERE_MCP_UI_PIPE = `PremiereMcpUi.SecuritySmoke.${process.pid}`;
childEnv.NODE_OPTIONS = "--require C:\\definitely-not-present\\attacker-preload.cjs";
childEnv.NODE_PATH = "C:\\definitely-not-present\\attacker-modules";
childEnv.PREMIERE_MCP_SECRET_HELPER = "C:\\definitely-not-present\\attacker-helper.exe";
childEnv.LOCALAPPDATA = "C:\\definitely-not-present\\attacker-local-app-data";
const transport = new StdioClientTransport({ command: launcher, args: ["--launch-mcp", bundle], cwd: root, env: childEnv, stderr: "pipe" });
let approvalId;

async function waitForLiveUxp() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const capabilities = await client.callTool({ name: "premiere_capabilities", arguments: {} });
    if (capabilities.structuredContent?.backends?.uxp?.available) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("Live UXP backend did not become available for the security smoke");
}

try {
  await client.connect(transport);
  await waitForLiveUxp();
  const listed = await client.listTools();
  assert.equal(
    listed.tools.some((tool) => /approv|confirm/i.test(tool.name)),
    false,
    "The MCP surface must not expose an approval or confirmation tool",
  );
  const preview = await client.callTool({ name: "premiere_operations", arguments: { mode: "preview", request: { actionId: "project.save", args: {} } } });
  approvalId = preview.structuredContent?.approvalId;
  assert.match(approvalId, /^[0-9a-f-]{36}$/i);
  assert.equal("token" in preview.structuredContent, false);
  const apply = await client.callTool({ name: "premiere_operations", arguments: { mode: "apply", request: { actionId: "project.save", args: {}, approvalId } } });
  assert.equal(apply.structuredContent?.status, "blocked");
  assert.equal(apply.structuredContent?.error?.code, "CONFIRMATION_REJECTED");
  process.stdout.write("SECURITY_SMOKE_OK broker_sign=true mcp_self_approval=false preload_scrubbed=true\n");
} finally {
  await client.close();
  if (approvalId) {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    await rm(join(localAppData, "PremiereMCP", "approvals", `pending-${approvalId}.json`), { force: true });
  }
}
