import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  POST_PRODUCTION_DOMAINS,
  buildPostProductionJobPlanInput,
  evaluateProgramReadiness,
  postProductionProgram,
  postProductionWorkflows,
} from "../src/features/program/index.js";
import type { JobRecord } from "../src/workflows/job-contracts.js";
import { checkpointEvidenceBindingDigest } from "../src/workflows/checkpoint.js";
import { buildDurableJobEvidence, verifyProgramEvidence } from "../src/verifiers/program/index.js";

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

function completedWorkflowJob(workflowId = "post.inspect_delivery"): JobRecord {
  const actions = ["effects.catalog", "captions.inspect", "project.checkpoint", "export.sequence", "project.checkpoint"];
  return {
    schemaVersion: 1,
    jobId: "10000000-0000-4000-8000-000000000000",
    name: workflowId,
    status: "succeeded",
    cancellation: { requested: false, boundary: "before_step_dispatch", requestedAt: null },
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:01:00.000Z",
    steps: actions.map((actionId, index) => {
      const stepId = `${String(index + 1).padStart(2, "0")}:${actionId}`;
      const operationId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      const checkpointPathDigest = digest(index === 2 ? "b" : "c");
      const projectPathDigest = digest("a");
      const contentDigest = digest(index === 2 ? "d" : "e");
      const checkpointData = actionId === "project.checkpoint" ? {
        checkpointCreated: true,
        bytes: 1024 + index,
        sha256: contentDigest,
        projectPathDigest,
        checkpointPathDigest,
        checkpointBindingDigest: checkpointEvidenceBindingDigest({ operationId, bytes: 1024 + index, sha256: contentDigest, projectPathDigest, checkpointPathDigest }),
      } : undefined;
      const result = {
        operationId,
        actionId,
        status: "succeeded" as const,
        backend: "uxp" as const,
        hostVersion: "26.3.0",
        risk: "R2" as const,
        beforeRevision: null,
        afterRevision: null,
        verification: { outcome: "verified" as const, method: "fixture readback" },
        undo: { available: false, method: null },
        createdFiles: [],
        warnings: [],
        ...(checkpointData ? { data: checkpointData } : {}),
      };
      return {
        stepId,
        request: { actionId, args: {}, operationId },
        dependsOn: index === 0 ? [] : [`${String(index).padStart(2, "0")}:${actions[index - 1]}`],
        status: "succeeded" as const,
        attempts: 1,
        result,
        evidence: { operationId, verificationOutcome: "verified" as const, verificationMethod: "fixture readback", verifiedCompleted: true, undoAvailable: false, beforeRevision: null, afterRevision: null },
      };
    }),
  };
}

describe("post-production program contracts", () => {
  it("covers every requested domain without claiming verified support", () => {
    expect(new Set(postProductionProgram.map((feature) => feature.domain))).toEqual(new Set(POST_PRODUCTION_DOMAINS));
    expect(new Set(postProductionProgram.map((feature) => feature.actionId)).size).toBe(postProductionProgram.length);
    expect(postProductionProgram.every((feature) => feature.evidenceState === "none")).toBe(true);
    expect(postProductionProgram.every((feature) => !(["verified", "verified_automated"] as string[]).includes(feature.availability))).toBe(true);
    expect(postProductionProgram.filter((feature) => feature.availability === "handler_unverified").map((feature) => feature.actionId).sort()).toEqual([
      "captions.inspect", "effects.apply", "effects.catalog", "export.frame", "export.sequence",
    ]);
  });

  it("requires durable premiere_jobs and verified checkpoints for every compound workflow", () => {
    expect(postProductionWorkflows.length).toBeGreaterThan(0);
    for (const workflow of postProductionWorkflows) {
      expect(workflow.executionSurface).toBe("premiere_jobs");
      expect(["plan_only", "implemented_unverified"]).toContain(workflow.availability);
      expect(workflow.requiresDurableJobRecord).toBe(true);
      expect(workflow.requiresVerifiedCheckpoint).toBe(true);
      expect(workflow.checkpointPolicy).toBe("trusted_profile_before_first_mutation_and_nonundoable");
      expect(workflow.requiresVerifiedPostWorkflowCheckpointEvidence).toBe(true);
      if (workflow.availability === "implemented_unverified") {
        expect(workflow.requiredActions.filter((actionId) => actionId === "project.checkpoint")).toHaveLength(2);
      } else {
        expect(workflow.requiredActions).not.toContain("project.checkpoint");
      }
      expect(workflow.unknownDispatchOutcome).toBe("reconciliation_required");
      expect(workflow.automaticRedispatchAfterUnknownOutcome).toBe(false);
    }
  });

  it("provides one executable unverified compound delivery workflow with checkpoint guard mutations", () => {
    const workflow = postProductionWorkflows.find((candidate) => candidate.workflowId === "post.inspect_delivery")!;
    expect(workflow.availability).toBe("implemented_unverified");
    const requests = workflow.requiredActions.map((actionId) => ({
      actionId,
      args: actionId === "export.sequence" ? { outputPath: "C:\\delivery\\out.mp4", presetPath: "C:\\delivery\\preset.epr", overwrite: false } : {},
    }));
    const plan = buildPostProductionJobPlanInput(workflow.workflowId, requests, { advertisedHandlers: workflow.requiredActions, verifiedEntitlements: [] });
    expect(plan.steps).toHaveLength(5);
    expect(plan.steps.map((step) => step.dependsOn)).toEqual([[], ["01:effects.catalog"], ["02:captions.inspect"], ["03:project.checkpoint"], ["04:export.sequence"]]);
    expect(plan.steps.filter((step) => step.request.actionId === "project.checkpoint")).toHaveLength(2);
  });

  it("routes workflow planning through the durable-job builder and blocks unavailable handlers", () => {
    const workflow = postProductionWorkflows.find((candidate) => candidate.workflowId === "post.color_delivery")!;
    const requests = workflow.requiredActions.map((actionId) => ({ actionId, args: {} }));
    expect(() => buildPostProductionJobPlanInput(workflow.workflowId, requests, { advertisedHandlers: ["export.sequence"], verifiedEntitlements: [] })).toThrow(expect.objectContaining({ code: "HANDLER_NOT_IMPLEMENTED" }));
    expect(() => buildPostProductionJobPlanInput(workflow.workflowId, requests, { advertisedHandlers: workflow.requiredActions, verifiedEntitlements: [] })).toThrow(expect.objectContaining({ code: "HANDLER_NOT_IMPLEMENTED" }));
  });

  it("fails entitlement-dependent work truthfully before handler dispatch", () => {
    const action = postProductionProgram.find((feature) => feature.actionId === "audio.enhance_speech")!;
    expect(evaluateProgramReadiness(action, { advertisedHandlers: [action.actionId], verifiedEntitlements: [] })).toEqual({
      status: "blocked_external",
      error: {
        code: "ENTITLEMENT_NOT_VERIFIED",
        message: "Adobe Enhance Speech entitlement was not verified by a runtime probe",
      },
    });
    expect(evaluateProgramReadiness(action, { advertisedHandlers: [], verifiedEntitlements: ["adobe.enhance_speech"] })).toMatchObject({
      status: "unsupported",
      error: { code: "HANDLER_NOT_IMPLEMENTED" },
    });
    expect(evaluateProgramReadiness(action, { advertisedHandlers: [action.actionId], verifiedEntitlements: ["adobe.enhance_speech"] })).toEqual({ status: "ready_unverified" });
  });

  it("never upgrades plan-only evidence and reconciles partial post-dispatch evidence", () => {
    const workflow = postProductionWorkflows.find((candidate) => candidate.workflowId === "post.color_delivery")!;
    expect(verifyProgramEvidence(workflow, {
      source: "plan_only",
      hostBuild: "26.3.0",
      capabilityFingerprint: `sha256:${"a".repeat(64)}`,
      disposableProject: true,
      restoredAfterRun: true,
    }).status).toBe("unverified");

    const partialJob = buildDurableJobEvidence(completedWorkflowJob());
    const { checkpoint: _checkpoint, ...stepWithoutCheckpoint } = partialJob.steps[4]!;
    partialJob.steps[4] = stepWithoutCheckpoint;
    const partial = verifyProgramEvidence(postProductionWorkflows.find((candidate) => candidate.workflowId === "post.inspect_delivery")!, {
      source: "fixture",
      fixtureId: "post-color-hdr",
      hostBuild: "26.3.0",
      capabilityFingerprint: `sha256:${"a".repeat(64)}`,
      disposableProject: true,
      restoredAfterRun: false,
      job: partialJob,
    });
    expect(partial.status).toBe("reconciliation_required");
    expect(partial.reasons).toContain("verified post-workflow checkpoint is missing");
  });

  it("requires action-specific readback before a live or fixture run can verify a feature", () => {
    const action = postProductionProgram.find((feature) => feature.actionId === "effects.catalog")!;
    const baseEvidence = {
      source: "fixture" as const,
      fixtureId: "post-effects-keyframes-masks",
      hostBuild: "26.3.0",
      capabilityFingerprint: `sha256:${"a".repeat(64)}`,
      disposableProject: true,
      restoredAfterRun: true,
    };
    expect(verifyProgramEvidence(action, baseEvidence).status).toBe("unverified");
    expect(verifyProgramEvidence(action, {
      ...baseEvidence,
      actionVerifications: [{ actionId: action.actionId, outcome: "verified", method: "typed effect catalog readback" }],
    }).status).toBe("verified");
  });

  it("accepts complete disposable fixture evidence including durable output proof", () => {
    const workflow = postProductionWorkflows.find((candidate) => candidate.workflowId === "post.inspect_delivery")!;
    expect(verifyProgramEvidence(workflow, {
      source: "fixture",
      fixtureId: "post-delivery-export",
      hostBuild: "26.3.0",
      capabilityFingerprint: `sha256:${"a".repeat(64)}`,
      disposableProject: true,
      restoredAfterRun: true,
      job: buildDurableJobEvidence(completedWorkflowJob()),
      outputs: [{ outputPathDigest: `sha256:${"d".repeat(64)}`, bytes: 1024, stableAcrossReads: true }],
    })).toEqual({ status: "verified", method: "disposable fixture evidence", reasons: [] });
  });

  it("rejects checkpoint evidence that is not bound to the exact durable job step", () => {
    const workflow = postProductionWorkflows.find((candidate) => candidate.workflowId === "post.inspect_delivery")!;
    const job = buildDurableJobEvidence(completedWorkflowJob());
    job.steps[4] = { ...job.steps[4]!, operationId: "00000000-0000-4000-8000-000000000099" };
    const result = verifyProgramEvidence(workflow, {
      source: "fixture",
      fixtureId: "post-delivery-export",
      hostBuild: "26.3.0",
      capabilityFingerprint: digest("f"),
      disposableProject: true,
      restoredAfterRun: true,
      job,
      outputs: [{ outputPathDigest: digest("9"), bytes: 1024, stableAcrossReads: true }],
    });
    expect(result.status).toBe("reconciliation_required");
    expect(result.reasons).toContain("checkpoint evidence 05:project.checkpoint is not bound to its durable job step");
  });
});

describe("post-production disposable fixture manifests", () => {
  it("provides plan-only isolated manifests for all six domains", () => {
    const directory = join(process.cwd(), "fixtures", "post-production");
    const files = readdirSync(directory).filter((file) => file.endsWith(".fixture.json"));
    expect(files).toHaveLength(POST_PRODUCTION_DOMAINS.length);
    const manifests = files.map((file) => JSON.parse(readFileSync(join(directory, file), "utf8")) as Record<string, any>);
    expect(new Set(manifests.map((manifest) => manifest.domain))).toEqual(new Set(POST_PRODUCTION_DOMAINS));
    for (const manifest of manifests) {
      expect(manifest.evidenceState).toBe("plan_only");
      expect(manifest.liveEvidence).toBe(false);
      expect(manifest.isolation).toEqual({ root: "unique-os-temporary-directory", userProjectAllowed: false, disposableProject: true });
      expect(manifest.requiredEvidence).toContain("host-build");
      expect(manifest.requiredEvidence).toContain("capability-fingerprint");
      expect(manifest.requiredEvidence).toContain("verified-action-readback");
      expect(manifest.cleanup).toEqual({ closeDisposableProject: true, removeTemporaryRoot: true, verifyRestoredState: true });
      expect(JSON.stringify(manifest)).not.toMatch(/[A-Z]:\\Users\\/i);
    }
  });
});
