import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const launcher = process.env.PREMIERE_MCP_LAUNCHER || join(localAppData, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe");
const bundle = process.env.PREMIERE_MCP_BUNDLE || join(localAppData, "PremiereMCP", "bundle", "premiere-mcp.bundle.mjs");
const client = new Client({ name: "premiere-mcp-ui-live-probe", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: launcher,
  args: ["--launch-mcp", bundle],
  stderr: "pipe",
  env: {
    ...process.env,
    PREMIERE_MCP_UXP_PORT: process.env.PREMIERE_MCP_PROBE_UXP_PORT || "17779",
    PREMIERE_MCP_UI_PIPE: `PremiereMcpUi.LiveProbe.${process.pid}`,
  },
});

try {
  await client.connect(transport);
  const result = await client.callTool(
    { name: "premiere_api", arguments: { actionId: "ui.catalog", args: { offset: 0, limit: 20 } } },
    undefined,
    { timeout: 60_000, maxTotalTimeout: 60_000 },
  );
  const value = result.structuredContent;
  if (result.isError === undefined && value?.status === "succeeded") {
    process.stdout.write(`${JSON.stringify({ ok: true, controls: value.data?.controls?.length ?? 0, complete: value.data?.complete ?? null, truncated: value.data?.truncated ?? null })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ ok: false, failClosed: true, errorCode: value?.error?.code ?? "UI_PROBE_FAILED" })}\n`);
    process.exitCode = 1;
  }
} finally {
  await client.close();
}
