#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stdin, stdout } from "node:process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const approvalId = process.argv[2];
  if (!approvalId) throw new Error("Usage: npm run approve -- <approval-id>");
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Approval must be launched from an interactive local terminal");
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const candidates = [
    ...(process.env.PREMIERE_MCP_SECRET_HELPER ? [process.env.PREMIERE_MCP_SECRET_HELPER] : []),
    join(localAppData, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe"),
    fileURLToPath(new URL("../../windows-ui-agent/bin/Release/net8.0-windows/PremiereMcp.WindowsUiAgent.exe", import.meta.url)),
  ];
  let lastError: unknown;
  for (const helper of candidates) {
    try {
      await execFileAsync(helper, ["--approval", "approve", approvalId], { timeout: 5 * 60_000, maxBuffer: 4096, encoding: "utf8" });
      stdout.write("Approved in the local Windows dialog for one use. Return to the MCP client and apply using the approvalId.\n");
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Approval broker failed: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
