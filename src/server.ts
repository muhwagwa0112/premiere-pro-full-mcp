import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { actionRequestSchema, domainSchema, type ActionDomain } from "./contracts.js";
import { getAction, listActions } from "./catalog.js";
import type { OperationEngine } from "./operation-engine.js";
import { JobEngine } from "./workflows/job-engine.js";
import { jobPlanInputSchema } from "./workflows/job-contracts.js";
import { listFeatureRegistry } from "./features/registry.js";
import { buildPostProductionJobPlanInput } from "./features/program/workflows.js";

const jsonRecord = z.record(z.string(), z.unknown());
const actionInputShape = {
  actionId: z.string().min(3).max(128),
  target: jsonRecord.optional(),
  args: jsonRecord.optional(),
  operationId: z.uuid().optional(),
  expectedRevision: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  approvalId: z.uuid().optional(),
  planHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
};

function textResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function normalizeRequest(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input, args: input.args ?? {} };
}

export function createServer(engine: OperationEngine, jobs?: JobEngine): McpServer {
  const server = new McpServer({ name: "premiere-pro-full-mcp", version: "0.3.0" });
  let jobEngine = jobs;
  const durableJobs = () => jobEngine ??= new JobEngine(engine);

  server.registerTool("premiere_capabilities", {
    title: "Premiere capabilities",
    description: "Report the local target, enabled authorities, backend readiness, action risk, and live-host verification boundaries.",
    inputSchema: { domain: domainSchema.optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ domain }) => {
    const capabilities = await engine.capabilities();
    if (domain) capabilities.actions = listActions(domain).map((action) => ({ id: action.id, title: action.title, risk: action.risk, support: action.support, preferredBackends: action.preferredBackends }));
    return textResult(capabilities);
  });

  const domains: Array<{ tool: string; domain: ActionDomain; title: string; description: string }> = [
    { tool: "premiere_api", domain: "api", title: "Premiere full API surface", description: "Search or invoke official UXP, safe legacy DOM/QE capabilities, and semantic UI fallback through one risk-gated surface." },
    { tool: "premiere_inspect", domain: "inspection", title: "Inspect Premiere", description: "Run a bounded read-only host, project, or sequence inspection action." },
    { tool: "premiere_project", domain: "project", title: "Premiere project", description: "Run a typed project lifecycle action." },
    { tool: "premiere_media", domain: "media", title: "Premiere media", description: "Run a typed media import, relink, proxy, or metadata action." },
    { tool: "premiere_timeline", domain: "timeline", title: "Premiere timeline", description: "Run a typed sequence, track, clip, selection, marker, or transition action." },
    { tool: "premiere_effects_audio", domain: "effects_audio", title: "Premiere effects and audio", description: "Discover or apply typed effects, parameters, keyframes, transitions, and audio operations." },
    { tool: "premiere_text_captions", domain: "text_captions", title: "Premiere text and captions", description: "Inspect or change graphics, transcripts, and captions through an advertised action." },
    { tool: "premiere_export", domain: "export", title: "Premiere export", description: "Run confirmed frame, sequence, interchange, or AME export actions." },
    { tool: "premiere_workspace", domain: "workspace", title: "Premiere workspace", description: "Control supported workspace, playback, panel, and history actions." },
    { tool: "premiere_plugins", domain: "plugins", title: "Premiere plugins", description: "Inventory installed effects/extensions or invoke a versioned semantic plugin adapter." },
    { tool: "premiere_cloud", domain: "cloud", title: "Premiere cloud", description: "Inspect or invoke approved signed-in Adobe cloud workflows without extracting credentials." },
  ];

  for (const entry of domains) {
    server.registerTool(entry.tool, {
      title: entry.title,
      description: entry.description,
      inputSchema: actionInputShape,
      annotations: { readOnlyHint: entry.domain === "inspection", destructiveHint: listActions(entry.domain).some((action) => action.risk === "R2" || action.risk === "R3"), openWorldHint: entry.domain === "cloud" },
    }, async (input) => {
      let action;
      try {
        action = getAction(input.actionId);
      } catch (error) {
        return textResult({ status: "failed", error: { code: "UNKNOWN_ACTION", message: (error as Error).message } });
      }
      if (action.domain !== entry.domain) return textResult({ status: "failed", error: { code: "DOMAIN_MISMATCH", message: `${action.id} belongs to ${action.domain}, not ${entry.domain}` } });
      const result = await engine.execute(normalizeRequest(input));
      return textResult({ ...result });
    });
  }

  server.registerTool("premiere_operations", {
    title: "Premiere operation lifecycle",
    description: "Preview and confirm R2/R3 work, apply an exact request, inspect operation status, or report cancellation/undo boundaries.",
    inputSchema: {
      mode: z.enum(["preview", "apply", "status", "cancel", "undo"]),
      request: jsonRecord.optional(),
      operationId: z.uuid().optional(),
    },
    annotations: { openWorldHint: false },
  }, async ({ mode, request, operationId }) => {
    try {
      if (mode === "preview") return textResult(await engine.preview(normalizeRequest(request ?? {})));
      if (mode === "apply") return textResult({ ...(await engine.execute(normalizeRequest(request ?? {}))) });
      if (mode === "status") {
        if (!operationId) throw new Error("operationId is required for status");
        return textResult(await engine.status(operationId));
      }
      if (mode === "undo") return textResult({ ...(await engine.execute({ actionId: "history.undo", args: {}, ...(operationId ? { operationId } : {}) })) });
      return textResult({ status: "blocked", error: { code: "CANCEL_BOUNDARY", message: "Cancellation is cooperative only before a host call. No cancellable pre-dispatch operation is active." } });
    } catch (error) {
      return textResult({ status: "failed", error: { code: "OPERATION_REQUEST_REJECTED", message: (error as Error).message } });
    }
  });

  server.registerTool("premiere_jobs", {
    title: "Durable Premiere job lifecycle",
    description: "Plan and durably execute a DAG of Premiere operations, inspect status, request cooperative cancellation, resume verified work, or perform evidence-based rollback.",
    inputSchema: {
      mode: z.enum(["plan", "workflow_plan", "execute", "status", "cancel", "resume", "rollback"]),
      job: jobPlanInputSchema.optional(),
      workflowId: z.string().min(3).max(128).optional(),
      requests: z.array(actionRequestSchema).max(128).optional(),
      jobId: z.uuid().optional(),
    },
    annotations: { openWorldHint: false },
  }, async ({ mode, job, workflowId, requests, jobId }) => {
    try {
      if (mode === "plan") {
        if (!job) throw new Error("job is required for plan");
        return textResult({ ...(await durableJobs().plan(job)) });
      }
      if (mode === "workflow_plan") {
        if (!workflowId || !requests) throw new Error("workflowId and requests are required for workflow_plan");
        const capabilities = await engine.capabilities() as { backends?: Record<string, { available?: boolean; operations?: string[] }> };
        const advertisedHandlers = [...new Set(Object.values(capabilities.backends ?? {}).filter((probe) => probe.available).flatMap((probe) => probe.operations ?? []))];
        const jobPlan = buildPostProductionJobPlanInput(workflowId, requests, { advertisedHandlers, verifiedEntitlements: [] });
        return textResult({ ...(await durableJobs().plan(jobPlan)) });
      }
      if (!jobId) throw new Error(`jobId is required for ${mode}`);
      if (mode === "execute") return textResult({ ...(await durableJobs().execute(jobId)) });
      if (mode === "status") return textResult({ ...(await durableJobs().status(jobId)) });
      if (mode === "cancel") return textResult({ ...(await durableJobs().cancel(jobId)) });
      if (mode === "resume") return textResult({ ...(await durableJobs().resume(jobId)) });
      return textResult({ ...(await durableJobs().rollback(jobId)) });
    } catch (error) {
      return textResult({ status: "failed", error: { code: "JOB_REQUEST_REJECTED", message: (error as Error).message } });
    }
  });

  server.registerResource("premiere-capabilities", "premiere://capabilities", {
    title: "Premiere capability catalog",
    description: "Current backend availability, authorities, and action support states.",
    mimeType: "application/json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await engine.capabilities(), null, 2) }] }));

  server.registerResource("premiere-feature-registry", "premiere://features", {
    title: "Premiere feature registry",
    description: "Complete user-facing Premiere feature-family registry with truthful backend, evidence state, version, precondition, and verifier classifications.",
    mimeType: "application/json",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(listFeatureRegistry(), null, 2) }] }));

  server.registerResource("premiere-actions", new ResourceTemplate("premiere://actions/{domain}", { list: undefined }), {
    title: "Premiere domain actions",
    description: "Action contracts for one Premiere domain.",
    mimeType: "application/json",
  }, async (uri, variables) => {
    const parsed = domainSchema.safeParse(variables.domain);
    const body = parsed.success
      ? listActions(parsed.data).map((action) => ({ id: action.id, title: action.title, description: action.description, risk: action.risk, authority: action.authority, support: action.support, preferredBackends: action.preferredBackends, minimumPremiereVersion: action.minimumPremiereVersion, mutatesProject: action.mutatesProject, undoable: action.undoable, verification: action.verification, argsSchema: z.toJSONSchema(action.argsSchema) }))
      : { error: "Unknown domain", allowed: domainSchema.options };
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
  });

  return server;
}
