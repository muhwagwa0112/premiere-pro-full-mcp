import { randomUUID } from "node:crypto";
import { mkdir, readFile, open, link, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BridgeClient } from "../bridge/ws-client.js";
import type { WsHost } from "../bridge/ws-host.js";
import { WorkflowService } from "../automation/service.js";
import { loadAutomationConfiguration } from "../automation/configuration.js";
import type { ControllerResponse, WorkflowHome } from "../automation/contracts.js";
import { createConfiguredWorker } from "../workers/configured-client.js";
import { createPremiereAutomationAdapter, parseParameterProfiles } from "../adobe-automation-adapter.js";
import { RemotePhotoshopAdapter, resolvePhotoshopDataDirectory } from "../photoshop-peer.js";
import { DurableEffectBatch } from "./effect-batch.js";
import { dispatchExactLegacyEffect } from "../server.js";

/** There is one workflow owner, in the existing Premiere daemon; stdio clients are RPC clients only. */
export async function attachPremiereAutomation(host: WsHost, stateDirectory: string): Promise<WorkflowService> {
  const dataDirectory = process.env.PREMIERE_MCP_AUTOMATION_DATA_DIR ?? join(stateDirectory, "automation");
  await mkdir(dataDirectory, { recursive: true });
  const workspace = process.env.PREMIERE_AUTOMATION_ROOT ?? join(dataDirectory, "workspace");
  await mkdir(workspace, { recursive: true });
  const config = await loadAutomationConfiguration({ dataDirectory, defaultRoots: { workspace }, defaultOutputDirectory: workspace });
  const photoshopDataDirectory = resolvePhotoshopDataDirectory(process.env.PHOTOSHOP_MCP_DATA_DIR);
  await mkdir(join(photoshopDataDirectory, "assets"), { recursive: true });
  config.roots.photoshop_staging = { path: join(photoshopDataDirectory, "assets"), readOnly: true };
  const installationPath = join(dataDirectory, "installation-id.json");
  let installationId: string;
  const candidatePath = installationPath + "." + randomUUID() + ".tmp";
  const file = await open(candidatePath, "wx", 0o600);
  const candidateId = "premiere-" + randomUUID();
  try { await file.writeFile(JSON.stringify({ schemaVersion: 1, installationId: candidateId })); await file.sync(); } finally { await file.close(); }
  try {
    await link(candidatePath, installationPath);
    installationId = candidateId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const saved = JSON.parse(await readFile(installationPath, "utf8")) as { schemaVersion?: number; installationId?: string };
    if (saved.schemaVersion !== 1 || !/^premiere-[a-f0-9-]{36}$/.test(String(saved.installationId))) throw new Error("Invalid persistent Premiere installation identity");
    installationId = saved.installationId!;
  } finally { await unlink(candidatePath); }
  const workflowHome: WorkflowHome = { app: "premiere", installationId, namespaceId: "automation-" + installationId };
  const worker = await createConfiguredWorker({ dataDirectory, roots: config.roots });
  const service = new WorkflowService({ workflowHome, dataDirectory, roots: config.roots, presets: config.presets,
    sequencePresets: config.sequencePresets, ...(worker ? { worker } : {}) });
  const bridge = await BridgeClient.connect(host.port);
  const parameterProfiles = process.env.PREMIERE_PARAMETER_PROFILE_FILE
    ? parseParameterProfiles(JSON.parse(await readFile(process.env.PREMIERE_PARAMETER_PROFILE_FILE, "utf8"))) : [];
  const adapter = createPremiereAutomationAdapter({ bridge, assets: service.assets, dataDirectory, installationId, parameterProfiles, ...(worker ? { worker } : {}) });
  service.registerHost("premiere", adapter, adapter.resolveHost);
  {
    const rootAliases: Record<string, string> = {};
    for (const [rootId, peerId] of [["workspace", "premiere_workspace"], ["output", "premiere_output"]] as const) {
      const root = config.roots[rootId], path = typeof root === "string" ? root : root?.path;
      if (path && resolve(path) === resolve(workspace)) rootAliases[rootId] = peerId;
    }
    const photoshop = new RemotePhotoshopAdapter({ dataDirectory: photoshopDataDirectory, rootAliases });
    service.registerHost("photoshop", photoshop, () => photoshop.resolveHost());
  }
  if (config.controller) service.configureOllama(config.controller);
  await service.start();
  const effectBatches = new DurableEffectBatch(bridge, dataDirectory, dispatchExactLegacyEffect);
  host.setWorkflowDispatcher(async (method, params) => {
    switch (method) {
      case "legacyEffectBatch": {
        const input = params as { toolName: string; args: unknown };
        return effectBatches.execute(input.toolName, input.args);
      }
      case "describe": return service.describe();
      case "submit": return service.submit(params);
      case "status": return service.status(params as { jobId?: string; requestId?: string; workflowHome?: WorkflowHome });
      case "cancel": return service.cancel(String(params));
      case "outputs": return service.outputs(String(params));
      case "operationStatus": return service.operationStatus(String(params));
      case "controllerRequest": return service.controllerRequest(String(params));
      case "controllerRespond": return service.controllerRespond(params as ControllerResponse);
      default: throw new Error("Unknown workflow method");
    }
  });
  return service;
}
