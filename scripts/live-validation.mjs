import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const workspace = join(localAppData, "PremiereMCP", "workspace", "live-validation");
const launcher = join(localAppData, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe");
const bundle = process.env.PREMIERE_MCP_BUNDLE || join(localAppData, "PremiereMCP", "bundle", "premiere-mcp.bundle.mjs");
const projectPath = join(workspace, "ppmcp-live-validation.prproj");
const mediaPath = join(workspace, "ppmcp-live-source.mp4");
const framePath = join(workspace, "ppmcp-live-frame.png");
const sequenceOutputPath = join(workspace, "ppmcp-live-sequence.mp4");
const sequencePresetPath = join(workspace, "ppmcp-live-preset.epr");
const stage = process.argv[2];

await mkdir(workspace, { recursive: true });

const client = new Client({ name: "premiere-mcp-live-validation", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: launcher,
  args: ["--launch-mcp", bundle],
  cwd: root,
  stderr: "pipe",
  env: {
    ...process.env,
    PREMIERE_MCP_UXP_PORT: process.env.PREMIERE_MCP_VALIDATION_UXP_PORT || "17779",
    PREMIERE_MCP_UI_PIPE: process.env.PREMIERE_MCP_VALIDATION_UI_PIPE || `PremiereMcpUi.Validation.${process.pid}`,
  },
});

function statePath(label) {
  return join(workspace, `.ppmcp-${label}.json`);
}

function data(result) {
  assert.equal(result.isError, undefined);
  return result.structuredContent;
}

async function preview(label, actionId, args) {
  const request = { actionId, args };
  const result = data(await client.callTool({ name: "premiere_operations", arguments: { mode: "preview", request } }));
  assert.equal(typeof result.approvalId, "string", JSON.stringify(result));
  await writeFile(statePath(label), JSON.stringify({ request, approvalId: result.approvalId }, null, 2), "utf8");
  return { stage, label, approvalId: result.approvalId, expiresAt: result.expiresAt, approvalCommand: result.approvalCommand, request };
}

async function apply(label) {
  const saved = JSON.parse(await readFile(statePath(label), "utf8"));
  const request = { ...saved.request, approvalId: saved.approvalId };
  if (["export.frame", "project.save", "uxp.transaction.execute"].includes(saved.request.actionId)) {
    const deadline = Date.now() + 40_000;
    let available = false;
    while (Date.now() < deadline) {
      const capabilities = data(await client.callTool({ name: "premiere_capabilities", arguments: {} }, undefined, { timeout: 10_000 }));
      available = capabilities.backends?.uxp?.available === true;
      if (available) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    assert.equal(available, true, "Authenticated UXP panel did not reconnect before apply");
  }
  const timeout = saved.request.actionId === "export.sequence" ? 10 * 60_000 : 60_000;
  const result = data(await client.callTool({ name: "premiere_operations", arguments: { mode: "apply", request } }, undefined, { timeout }));
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  await writeFile(statePath(`${label}-result`), JSON.stringify(result, null, 2), "utf8");
  return { stage, label, result };
}

async function direct(tool, actionId, args) {
  const result = data(await client.callTool({ name: tool, arguments: { actionId, args } }));
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  return result;
}

try {
  await client.connect(transport);
  let output;
  switch (stage) {
    case "preview-create":
      output = await preview("create", "project.create", { path: projectPath });
      break;
    case "apply-create": {
      output = await apply("create");
      const file = await stat(projectPath);
      assert(file.size > 0, "Created project is empty");
      output.projectFile = { path: projectPath, bytes: file.size };
      break;
    }
    case "preview-open":
      output = await preview("open", "project.open", { path: projectPath });
      break;
    case "apply-open":
      output = await apply("open");
      assert.equal(output.result.verification?.outcome, "verified");
      break;
    case "preview-import":
      output = await preview("import", "media.import", { paths: [mediaPath] });
      break;
    case "apply-import":
      output = await apply("import");
      assert.equal(output.result.verification?.outcome, "verified");
      assert.equal(output.result.data?.items?.[0]?.pathVerified, true);
      break;
    case "create-sequence": {
      const imported = JSON.parse(await readFile(statePath("import-result"), "utf8"));
      const projectItemId = imported.data?.items?.[0]?.nodeId;
      assert.equal(typeof projectItemId, "string");
      const result = await direct("premiere_timeline", "timeline.sequence.create_from_media", { name: "PPMCP Live Validation", projectItemIds: [projectItemId] });
      assert.equal(result.verification?.outcome, "verified");
      output = { stage, result };
      await writeFile(statePath("sequence-result"), JSON.stringify(result, null, 2), "utf8");
      break;
    }
    case "preview-frame":
      output = await preview("frame", "export.frame", { outputPath: framePath, timeSeconds: 1 });
      break;
    case "apply-frame": {
      output = await apply("frame");
      const file = await stat(framePath);
      assert(file.size > 0, "Exported frame is empty");
      output.frameFile = { path: framePath, bytes: file.size };
      break;
    }
    case "preview-sequence-export":
      output = await preview("sequence-export", "export.sequence", { outputPath: sequenceOutputPath, presetPath: sequencePresetPath, overwrite: false });
      break;
    case "apply-sequence-export": {
      output = await apply("sequence-export");
      const file = await stat(sequenceOutputPath);
      assert(file.size > 0, "Exported sequence is empty");
      output.sequenceFile = { path: sequenceOutputPath, bytes: file.size };
      break;
    }
    case "preview-save":
      output = await preview("save", "project.save", {});
      break;
    case "apply-save": {
      output = await apply("save");
      const file = await stat(projectPath);
      assert(file.size > 0, "Saved project is empty");
      output.projectFile = { path: projectPath, bytes: file.size };
      break;
    }
    case "readback": {
      const project = await direct("premiere_inspect", "project.inspect", {});
      const sequence = await direct("premiere_inspect", "sequence.inspect", {});
      const projectFile = await stat(projectPath);
      const frameFile = await stat(framePath);
      output = {
        stage,
        project: project.data,
        sequence: sequence.data,
        files: {
          project: { path: projectPath, bytes: projectFile.size },
          frame: { path: framePath, bytes: frameFile.size },
          source: { path: mediaPath, name: basename(mediaPath), bytes: (await stat(mediaPath)).size },
        },
      };
      break;
    }
    case "catalog-sequence-export": {
      const result = await direct("premiere_api", "cep.surface.catalog", { root: "activeSequence", query: "export", offset: 0, limit: 200 });
      output = { stage, result: result.data };
      break;
    }
    default:
      throw new Error("stage must be one of preview-create, apply-create, preview-open, apply-open, preview-import, apply-import, create-sequence, preview-frame, apply-frame, preview-sequence-export, apply-sequence-export, preview-save, apply-save, readback, catalog-sequence-export");
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  await client.close();
}
