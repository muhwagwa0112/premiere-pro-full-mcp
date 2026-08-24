import type { ProgramFeatureContract, ProgramWorkflowContract } from "../../features/program/contracts.js";
import { sha256Canonical } from "../../security/execution-plan.js";
import { checkpointEvidenceBindingDigest } from "../../workflows/checkpoint.js";
import type { JobRecord } from "../../workflows/job-contracts.js";
import type { DurableJobEvidence, DurableJobStepEvidence, ProgramEvidence, ProgramVerificationResult, VerifiedCheckpointEvidence } from "./contracts.js";

const missing = (condition: boolean, reason: string, reasons: string[]): void => {
  if (!condition) reasons.push(reason);
};

const isSha256 = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const isOperationId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);

function checkpointFromStep(step: JobRecord["steps"][number], stepIndex: number): VerifiedCheckpointEvidence | undefined {
  if (step.request.actionId !== "project.checkpoint" || !step.result || step.result.status !== "succeeded" || step.result.verification.outcome !== "verified") return undefined;
  const data = step.result.data && typeof step.result.data === "object" ? step.result.data as Record<string, unknown> : {};
  if (data.checkpointCreated !== true || !Number.isSafeInteger(data.bytes) || (data.bytes as number) <= 0) return undefined;
  if (![data.sha256, data.projectPathDigest, data.checkpointPathDigest, data.checkpointBindingDigest].every(isSha256)) return undefined;
  return {
    stepId: step.stepId,
    stepIndex,
    operationId: step.result.operationId,
    verificationOutcome: "verified",
    checkpointPathDigest: data.checkpointPathDigest as `sha256:${string}`,
    projectPathDigest: data.projectPathDigest as `sha256:${string}`,
    contentDigest: data.sha256 as `sha256:${string}`,
    checkpointBindingDigest: data.checkpointBindingDigest as `sha256:${string}`,
    bytes: data.bytes as number,
  };
}

/** Build workflow evidence only from a JobRecord returned by the protected durable job store. */
export function buildDurableJobEvidence(record: JobRecord): DurableJobEvidence {
  const steps: DurableJobStepEvidence[] = record.steps.map((step, stepIndex) => {
    const checkpoint = checkpointFromStep(step, stepIndex);
    return {
      stepId: step.stepId,
      actionId: step.request.actionId,
      operationId: step.result?.operationId ?? step.request.operationId ?? "",
      dependsOn: [...step.dependsOn],
      status: step.status === "succeeded" ? "succeeded" : "not_succeeded",
      verificationOutcome: step.result?.verification.outcome === "verified" ? "verified" : "not_verified",
      verifiedCompleted: step.evidence?.verifiedCompleted === true,
      ...(checkpoint ? { checkpoint } : {}),
    };
  });
  return {
    jobId: record.jobId,
    jobName: record.name ?? null,
    schemaVersion: 1,
    persisted: true,
    terminalStatus: record.status,
    allStepsVerified: record.status === "succeeded" && steps.every((step) => step.status === "succeeded" && step.verifiedCompleted),
    recordDigest: sha256Canonical(record) as `sha256:${string}`,
    steps,
  };
}

function validateWorkflowJob(subject: ProgramWorkflowContract, job: DurableJobEvidence, reasons: string[]): void {
  missing(isSha256(job.recordDigest), "durable job record digest is missing or invalid", reasons);
  missing(job.jobName === subject.workflowId, "durable job record is not bound to this workflow", reasons);
  missing(job.steps.length === subject.requiredActions.length && job.steps.every((step, index) => step.actionId === subject.requiredActions[index]), "durable job step order does not match the workflow contract", reasons);
  for (let index = 0; index < job.steps.length; index++) {
    const step = job.steps[index]!;
    missing(isOperationId(step.operationId), `job step ${step.stepId} has no valid operation id`, reasons);
    missing(step.status === "succeeded" && step.verificationOutcome === "verified" && step.verifiedCompleted, `job step ${step.stepId} is not verified complete`, reasons);
    const expectedDependencies = index === 0 ? [] : [job.steps[index - 1]!.stepId];
    missing(step.dependsOn.length === expectedDependencies.length && step.dependsOn.every((value, dependencyIndex) => value === expectedDependencies[dependencyIndex]), `job step ${step.stepId} is not in the required linear durable DAG`, reasons);
  }
  const checkpoints = job.steps.map((step) => step.checkpoint).filter((entry): entry is VerifiedCheckpointEvidence => Boolean(entry));
  const expectedCheckpointIndexes = subject.requiredActions.map((actionId, index) => actionId === "project.checkpoint" ? index : -1).filter((index) => index >= 0);
  missing(checkpoints.length === expectedCheckpointIndexes.length, "durable job checkpoint evidence count does not match the workflow contract", reasons);
  for (let checkpointIndex = 0; checkpointIndex < checkpoints.length; checkpointIndex++) {
    const checkpoint = checkpoints[checkpointIndex]!;
    const expectedStepIndex = expectedCheckpointIndexes[checkpointIndex];
    const step = expectedStepIndex === undefined ? undefined : job.steps[expectedStepIndex];
    missing(checkpoint.stepIndex === expectedStepIndex && checkpoint.stepId === step?.stepId && checkpoint.operationId === step?.operationId, `checkpoint evidence ${checkpoint.stepId} is not bound to its durable job step`, reasons);
    missing(isOperationId(checkpoint.operationId), `checkpoint evidence ${checkpoint.stepId} has no valid operation id`, reasons);
    missing(checkpoint.verificationOutcome === "verified", `checkpoint evidence ${checkpoint.stepId} is not verified`, reasons);
    missing(isSha256(checkpoint.projectPathDigest) && isSha256(checkpoint.checkpointPathDigest) && isSha256(checkpoint.contentDigest), `checkpoint evidence ${checkpoint.stepId} has invalid digests`, reasons);
    missing(Number.isSafeInteger(checkpoint.bytes) && checkpoint.bytes > 0, `checkpoint evidence ${checkpoint.stepId} has an invalid byte count`, reasons);
    const expectedBinding = checkpointEvidenceBindingDigest({ operationId: checkpoint.operationId, bytes: checkpoint.bytes, sha256: checkpoint.contentDigest, projectPathDigest: checkpoint.projectPathDigest, checkpointPathDigest: checkpoint.checkpointPathDigest });
    missing(checkpoint.checkpointBindingDigest === expectedBinding, `checkpoint evidence ${checkpoint.stepId} binding digest is invalid`, reasons);
  }
  const before = checkpoints[0];
  const after = checkpoints.at(-1);
  missing(Boolean(before), "verified pre-workflow checkpoint is missing", reasons);
  missing(Boolean(after) && after !== before, "verified post-workflow checkpoint is missing", reasons);
  if (before && after) {
    missing(before.projectPathDigest === after.projectPathDigest, "workflow checkpoints are not bound to the same project path", reasons);
    missing(before.operationId !== after.operationId, "workflow checkpoints reused one operation id", reasons);
    missing(before.checkpointPathDigest !== after.checkpointPathDigest, "workflow checkpoints reused one checkpoint artifact", reasons);
  }
}

export function verifyProgramEvidence(
  subject: ProgramFeatureContract | ProgramWorkflowContract,
  evidence: ProgramEvidence,
): ProgramVerificationResult {
  if ("entitlement" in subject && subject.entitlement && !evidence.entitlementReceipts?.includes(subject.entitlement.key)) {
    return { status: "blocked_external", method: "runtime entitlement probe required", reasons: [`${subject.entitlement.product} entitlement has no verified runtime receipt`] };
  }
  if (evidence.source === "plan_only") {
    return { status: "unverified", method: "plan-only evidence is non-verifying", reasons: ["A disposable fixture run or live-host run is required"] };
  }

  const reasons: string[] = [];
  missing(evidence.hostBuild.trim().length > 0, "host build is missing", reasons);
  missing(isSha256(evidence.capabilityFingerprint), "capability fingerprint is missing or invalid", reasons);
  missing(evidence.disposableProject, "run did not use a disposable project", reasons);
  missing(evidence.restoredAfterRun, "post-run restoration was not verified", reasons);
  if (evidence.source === "fixture") missing(Boolean(evidence.fixtureId), "fixture id is missing", reasons);

  if ("actionId" in subject) {
    const actionEvidence = evidence.actionVerifications?.find((entry) => entry.actionId === subject.actionId);
    missing(actionEvidence?.outcome === "verified", `verified action readback is missing for ${subject.actionId}`, reasons);
    missing(Boolean(actionEvidence?.method.trim()), `verification method is missing for ${subject.actionId}`, reasons);
  }

  if ("workflowId" in subject) {
    missing(evidence.job?.persisted === true, "durable premiere_jobs record is missing", reasons);
    missing(evidence.job?.terminalStatus === "succeeded", "job did not reach succeeded", reasons);
    missing(evidence.job?.allStepsVerified === true, "not every job step has verified completion evidence", reasons);
    if (evidence.job) validateWorkflowJob(subject, evidence.job, reasons);
  }

  const exportsFile = "exportsFile" in subject ? subject.exportsFile : subject.kind === "compound_export";
  if (exportsFile) {
    missing(Boolean(evidence.outputs?.length), "no output evidence was supplied", reasons);
    for (const output of evidence.outputs ?? []) {
      missing(isSha256(output.outputPathDigest), "output path digest is missing or invalid", reasons);
      missing(output.bytes > 0, "output is empty", reasons);
      missing(output.stableAcrossReads, "output was not stable across reads", reasons);
    }
  }

  if (reasons.length > 0) {
    const unknownOutcome = "workflowId" in subject && Boolean(evidence.job);
    return { status: unknownOutcome ? "reconciliation_required" : "unverified", method: "evidence contract validation", reasons };
  }
  return { status: "verified", method: evidence.source === "fixture" ? "disposable fixture evidence" : "live host evidence", reasons: [] };
}
