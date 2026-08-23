import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const launcher = join(localAppData, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe");
const bundle = join(localAppData, "PremiereMCP", "bundle", "premiere-mcp.bundle.mjs");
const uxpPort = process.env.PREMIERE_MCP_UXP_PORT || "17777";
const client = new Client({ name: "premiere-mcp-uxp-transaction-validation", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: launcher,
  args: ["--launch-mcp", bundle],
  stderr: "pipe",
  env: { ...process.env, PREMIERE_MCP_UXP_PORT: uxpPort, PREMIERE_MCP_UI_PIPE: `PremiereMcpUi.TransactionProbe.${process.pid}` },
});

function data(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent;
}

async function call(tool, actionId, args) {
  const result = data(await client.callTool({ name: tool, arguments: { actionId, args } }, undefined, { timeout: 20_000 }));
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  return result;
}

async function read(memberId, args = {}) {
  const outcome = await call("premiere_api", "uxp.read", { memberId, arguments: [], ...args });
  return outcome.data.result;
}

async function waitForUxp() {
  const deadline = Date.now() + 40_000;
  let capabilities;
  while (Date.now() < deadline) {
    capabilities = data(await client.callTool({ name: "premiere_capabilities", arguments: {} }, undefined, { timeout: 10_000 }));
    if (capabilities.backends?.uxp?.available) return capabilities.backends.uxp;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.fail(JSON.stringify(capabilities?.backends?.uxp));
}

async function waitForEnter(label) {
  process.stdout.write(`WAITING_FOR_${label}_APPROVAL\n`);
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once("data", resolve));
}

async function approvedTransaction(label, target, actions, undoString) {
  const request = { actionId: "uxp.transaction.execute", args: { target, actions, undoString } };
  const preview = data(await client.callTool({ name: "premiere_operations", arguments: { mode: "preview", request } }, undefined, { timeout: 10_000 }));
  assert.equal(typeof preview.approvalId, "string", JSON.stringify(preview));
  process.stdout.write(`${JSON.stringify({ phase: label, approvalId: preview.approvalId, approvalCommand: preview.approvalCommand }, null, 2)}\n`);
  await waitForEnter(label.toUpperCase());
  const applied = data(await client.callTool({ name: "premiere_operations", arguments: { mode: "apply", request: { ...request, approvalId: preview.approvalId } } }, undefined, { timeout: 30_000 }));
  assert.equal(applied.status, "succeeded", JSON.stringify(applied));
  assert.equal(applied.data?.committed, true, JSON.stringify(applied));
  assert.equal(applied.data?.actionCount, actions.length, JSON.stringify(applied));
  return applied;
}

try {
  await client.connect(transport);
  const uxp = await waitForUxp();
  const project = await read("ProjectStatic.getActiveProject");
  assert.equal(project?.type, "Project", JSON.stringify(project));
  const sequence = await read("Project.getActiveSequence", { target: project });
  assert.equal(sequence?.type, "Sequence", JSON.stringify(sequence));
  const track = await read("Sequence.getVideoTrack", { target: sequence, arguments: [0] });
  assert.equal(track?.type, "VideoTrack", JSON.stringify(track));
  const originalName = await read("VideoTrack.name", { target: track });
  assert.equal(typeof originalName, "string");
  const forcedRestoreName = process.env.PREMIERE_MCP_RESTORE_TRACK_NAME;
  const changedName = `PPMCP Live R3 ${Date.now()}`;
  const action = (name) => [{ memberId: "VideoTrack.createSetNameAction", target: track, arguments: [name] }];

  if (forcedRestoreName) {
    const restored = await approvedTransaction("restore", project, action(forcedRestoreName), "Restore Premiere MCP live R3 validation");
    const restoredReadback = await read("VideoTrack.name", { target: track });
    assert.equal(restoredReadback, forcedRestoreName);
    process.stdout.write(`${JSON.stringify({ ok: true, recovery: true, uxp, project, sequence, track, priorName: originalName, restoredReadback, restoreVerification: restored.verification }, null, 2)}\n`);
    process.exitCode = 0;
  } else {

    const changed = await approvedTransaction("change", project, action(changedName), "Premiere MCP live R3 validation");
    const changedReadback = await read("VideoTrack.name", { target: track });
    assert.equal(changedReadback, changedName);

    const restored = await approvedTransaction("restore", project, action(originalName), "Restore Premiere MCP live R3 validation");
    const restoredReadback = await read("VideoTrack.name", { target: track });
    assert.equal(restoredReadback, originalName);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      uxp,
      project,
      sequence,
      track,
      originalName,
      changedName,
      changedReadback,
      restoredReadback,
      changeVerification: changed.verification,
      restoreVerification: restored.verification,
    }, null, 2)}\n`);
  }
} finally {
  await client.close();
}
