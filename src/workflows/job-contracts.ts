import { z } from "zod";
import { actionRequestSchema, type ActionRequest, type OperationResult } from "../contracts.js";

export const jobStepIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export const jobStepInputSchema = z.object({
  stepId: jobStepIdSchema,
  request: actionRequestSchema,
  dependsOn: z.array(jobStepIdSchema).max(128).default([]),
  rollbackRequest: actionRequestSchema.optional(),
}).strict();

export const jobPlanInputSchema = z.object({
  jobId: z.uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  steps: z.array(jobStepInputSchema).min(1).max(128),
}).strict();

export type JobPlanInput = z.infer<typeof jobPlanInputSchema>;

export type JobStatus = "planned" | "running" | "cancel_pending" | "cancelled" | "succeeded" | "failed" | "reconciliation_required" | "rolling_back" | "rolled_back" | "rollback_failed";
export type JobStepStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "reconciliation_required" | "rolled_back" | "rollback_failed";

export interface JobStepEvidence {
  operationId: string;
  verificationOutcome: OperationResult["verification"]["outcome"];
  verificationMethod: string;
  verifiedCompleted: boolean;
  undoAvailable: boolean;
  beforeRevision: string | null;
  afterRevision: string | null;
}

export interface JobStepRecord {
  stepId: string;
  request: ActionRequest;
  dependsOn: string[];
  rollbackRequest?: ActionRequest;
  status: JobStepStatus;
  attempts: number;
  result?: OperationResult;
  evidence?: JobStepEvidence;
  rollbackResult?: OperationResult;
}

export interface JobRecord {
  schemaVersion: 1;
  jobId: string;
  name?: string;
  status: JobStatus;
  cancellation: {
    requested: boolean;
    boundary: "before_step_dispatch";
    requestedAt: string | null;
  };
  createdAt: string;
  updatedAt: string;
  steps: JobStepRecord[];
  error?: { code: string; message: string };
}
