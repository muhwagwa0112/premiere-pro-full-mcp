import assert from "node:assert/strict";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const workspace = process.env.PREMIERE_MCP_VALIDATION_WORKSPACE || join(localAppData, "PremiereMCP", "workspace", "live-validation");
const launcher = join(localAppData, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe");
const bundle = process.env.PREMIERE_MCP_BUNDLE || join(localAppData, "PremiereMCP", "bundle", "premiere-mcp.bundle.mjs");
const projectPath = join(workspace, "ppmcp-live-validation.prproj");
const mediaPath = process.env.PREMIERE_MCP_VALIDATION_MEDIA || join(workspace, "ppmcp-live-source.mp4");
const framePath = join(workspace, "ppmcp-live-frame.png");
const sequenceOutputPath = join(workspace, "ppmcp-live-sequence.mp4");
const sequencePresetPath = process.env.PREMIERE_MCP_VALIDATION_PRESET || join(workspace, "ppmcp-live-preset.epr");
const approvalDirectory = join(localAppData, "PremiereMCP", "approvals");
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
    // The installed panel is paired to the release bootstrap on 17777. Tests that
    // need isolation can still override this port explicitly.
    PREMIERE_MCP_UXP_PORT: process.env.PREMIERE_MCP_VALIDATION_UXP_PORT || "17777",
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

async function waitForUxp(timeout = 40_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const capabilities = data(await client.callTool({ name: "premiere_capabilities", arguments: {} }, undefined, { timeout: 10_000 }));
    if (capabilities.backends?.uxp?.available === true) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Authenticated UXP panel did not reconnect before validation planning");
}

async function preview(label, actionId, args, requireUxp = true) {
  if (requireUxp) await waitForUxp();
  const request = { actionId, args };
  const result = data(await client.callTool({ name: "premiere_operations", arguments: { mode: "preview", request } }));
  assert.equal(typeof result.approvalId, "string", JSON.stringify(result));
  assert.equal(typeof result.operationId, "string", JSON.stringify(result));
  assert.equal(typeof result.planHash, "string", JSON.stringify(result));
  const boundRequest = { ...request, operationId: result.operationId, planHash: result.planHash };
  await writeFile(statePath(label), JSON.stringify({ request: boundRequest, approvalId: result.approvalId }, null, 2), "utf8");
  return { stage, label, approvalId: result.approvalId, expiresAt: result.expiresAt, approvalCommand: result.approvalCommand, request: boundRequest };
}

async function apply(label, requireUxp = true) {
  const saved = JSON.parse(await readFile(statePath(label), "utf8"));
  const request = { ...saved.request, approvalId: saved.approvalId };
  if (requireUxp) await waitForUxp(saved.request.actionId === "export.sequence" ? 120_000 : 40_000);
  const timeout = saved.request.actionId === "export.sequence" ? 10 * 60_000 : 60_000;
  const result = data(await client.callTool({ name: "premiere_operations", arguments: { mode: "apply", request } }, undefined, { timeout }));
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  await writeFile(statePath(`${label}-result`), JSON.stringify(result, null, 2), "utf8");
  return { stage, label, result };
}

async function previewAndApply(label, actionId, args, requireUxp = true) {
  const prepared = await preview(label, actionId, args, requireUxp);
  process.stdout.write(`${JSON.stringify({ event: "approval_required", ...prepared })}\n`);
  const approvedPath = join(approvalDirectory, `approved-${prepared.approvalId}.json`);
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (await access(approvedPath).then(() => true, () => false)) return apply(label, requireUxp);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Approval ${prepared.approvalId} was not completed before the validation deadline`);
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
    case "run-create": {
      output = await previewAndApply("create", "project.create", { path: projectPath });
      const file = await stat(projectPath);
      assert(file.size > 0, "Created project is empty");
      output.projectFile = { path: projectPath, bytes: file.size };
      break;
    }
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
      output = await preview("open", "project.open", { path: projectPath }, false);
      break;
    case "run-open": {
      output = await previewAndApply("open", "project.open", { path: projectPath }, false);
      assert.equal(output.result.verification?.outcome, "verified");
      break;
    }
    case "apply-open":
      output = await apply("open", false);
      assert.equal(output.result.verification?.outcome, "verified");
      break;
    case "preview-import":
      output = await preview("import", "media.import", { paths: [mediaPath] });
      break;
    case "run-import": {
      output = await previewAndApply("import", "media.import", { paths: [mediaPath] });
      assert.equal(output.result.verification?.outcome, "verified");
      assert.equal(output.result.data?.items?.[0]?.pathVerified, true);
      break;
    }
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
    case "run-frame": {
      output = await previewAndApply("frame", "export.frame", { outputPath: framePath, timeSeconds: 1 });
      const file = await stat(framePath);
      assert(file.size > 0, "Exported frame is empty");
      output.frameFile = { path: framePath, bytes: file.size };
      break;
    }
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
    case "run-sequence-export": {
      output = await previewAndApply("sequence-export", "export.sequence", { outputPath: sequenceOutputPath, presetPath: sequencePresetPath, overwrite: false });
      const file = await stat(sequenceOutputPath);
      assert(file.size > 0, "Exported sequence is empty");
      output.sequenceFile = { path: sequenceOutputPath, bytes: file.size };
      break;
    }
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
    case "run-save": {
      output = await previewAndApply("save", "project.save", {});
      const file = await stat(projectPath);
      assert(file.size > 0, "Saved project is empty");
      output.projectFile = { path: projectPath, bytes: file.size };
      break;
    }
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
      throw new Error("stage must be one of run-create, preview-create, apply-create, run-open, preview-open, apply-open, run-import, preview-import, apply-import, create-sequence, run-frame, preview-frame, apply-frame, run-sequence-export, preview-sequence-export, apply-sequence-export, run-save, preview-save, apply-save, readback, catalog-sequence-export");
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  await client.close();
}
