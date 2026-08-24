import type { ActionRequest } from "../../contracts.js";
import type { JobPlanInput } from "../../workflows/job-contracts.js";
import { evaluateProgramReadiness, postProductionProgram } from "./catalog.js";
import type { ProgramRuntimeReadiness, ProgramWorkflowContract } from "./contracts.js";

const workflow = (
  workflowId: string,
  kind: ProgramWorkflowContract["kind"],
  domains: ProgramWorkflowContract["domains"],
  requiredActions: string[],
  availability: ProgramWorkflowContract["availability"] = "plan_only",
): ProgramWorkflowContract => ({
  workflowId,
  domains,
  kind,
  availability,
  executionSurface: "premiere_jobs",
  requiredActions,
  requiresDurableJobRecord: true,
  requiresVerifiedCheckpoint: true,
  checkpointPolicy: "trusted_profile_before_first_mutation_and_nonundoable",
  requiresVerifiedPostWorkflowCheckpointEvidence: true,
  unknownDispatchOutcome: "reconciliation_required",
  automaticRedispatchAfterUnknownOutcome: false,
});

export const postProductionWorkflows: readonly ProgramWorkflowContract[] = [
  workflow("post.inspect_delivery", "compound_export", ["effects", "captions", "export"], ["effects.catalog", "captions.inspect", "project.checkpoint", "export.sequence", "project.checkpoint"], "implemented_unverified"),
  workflow("post.effects_pass", "compound_mutation", ["effects"], ["effects.apply", "effects.parameters"]),
  workflow("post.audio_mix", "compound_mutation", ["audio"], ["audio.clip_gain", "audio.volume_pan"]),
  workflow("post.caption_package", "compound_export", ["text", "captions", "export"], ["captions.track_cue.crud", "export.captions"]),
  workflow("post.color_delivery", "compound_export", ["color", "export"], ["color.lumetri", "export.sequence"]),
  workflow("post.delivery_batch", "compound_export", ["export"], ["export.batch"]),
];

export class ProgramWorkflowPlanningError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProgramWorkflowPlanningError";
  }
}

/** Builds the exact linear DAG consumed by premiere_jobs; it never dispatches. */
export function buildPostProductionJobPlanInput(workflowId: string, requests: readonly ActionRequest[], runtime: ProgramRuntimeReadiness): JobPlanInput {
  const contract = postProductionWorkflows.find((candidate) => candidate.workflowId === workflowId);
  if (!contract) throw new ProgramWorkflowPlanningError("WORKFLOW_UNKNOWN", `Unknown post-production workflow '${workflowId}'`);
  for (const actionId of contract.requiredActions) {
    if (actionId === "project.checkpoint") {
      if (!runtime.advertisedHandlers.includes(actionId)) throw new ProgramWorkflowPlanningError("HANDLER_NOT_IMPLEMENTED", `No runtime handler is advertised for ${actionId}`);
      continue;
    }
    const feature = postProductionProgram.find((candidate) => candidate.actionId === actionId);
    if (!feature) throw new ProgramWorkflowPlanningError("WORKFLOW_CONTRACT_INVALID", `Workflow action '${actionId}' has no program contract`);
    const readiness = evaluateProgramReadiness(feature, runtime);
    if (readiness.status !== "ready_unverified") throw new ProgramWorkflowPlanningError(readiness.error!.code, readiness.error!.message);
  }
  if (requests.length !== contract.requiredActions.length || requests.some((request, index) => request.actionId !== contract.requiredActions[index])) {
    throw new ProgramWorkflowPlanningError("WORKFLOW_REQUEST_MISMATCH", `Workflow '${workflowId}' requires requests in this exact order: ${contract.requiredActions.join(", ")}`);
  }
  return {
    name: workflowId,
    steps: requests.map((request, index) => ({
      stepId: `${String(index + 1).padStart(2, "0")}:${request.actionId}`,
      request,
      dependsOn: index === 0 ? [] : [`${String(index).padStart(2, "0")}:${requests[index - 1]!.actionId}`],
    })),
  };
}
