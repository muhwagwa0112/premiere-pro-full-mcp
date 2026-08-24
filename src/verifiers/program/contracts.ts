export interface VerifiedCheckpointEvidence {
  stepId: string;
  stepIndex: number;
  operationId: string;
  verificationOutcome: "verified";
  checkpointPathDigest: `sha256:${string}`;
  projectPathDigest: `sha256:${string}`;
  contentDigest: `sha256:${string}`;
  checkpointBindingDigest: `sha256:${string}`;
  bytes: number;
}

export interface DurableJobStepEvidence {
  stepId: string;
  actionId: string;
  operationId: string;
  dependsOn: string[];
  status: "succeeded" | "not_succeeded";
  verificationOutcome: "verified" | "not_verified";
  verifiedCompleted: boolean;
  checkpoint?: VerifiedCheckpointEvidence;
}

export interface DurableJobEvidence {
  jobId: string;
  jobName: string | null;
  schemaVersion: 1;
  persisted: true;
  terminalStatus: "planned" | "running" | "cancel_pending" | "cancelled" | "succeeded" | "failed" | "reconciliation_required" | "rolling_back" | "rolled_back" | "rollback_failed";
  allStepsVerified: boolean;
  recordDigest: `sha256:${string}`;
  steps: DurableJobStepEvidence[];
}

export interface StableOutputEvidence {
  outputPathDigest: `sha256:${string}`;
  bytes: number;
  stableAcrossReads: true;
}

export interface ProgramEvidence {
  source: "plan_only" | "fixture" | "live";
  fixtureId?: string;
  hostBuild: string;
  capabilityFingerprint: string;
  disposableProject: boolean;
  restoredAfterRun: boolean;
  entitlementReceipts?: string[];
  actionVerifications?: Array<{
    actionId: string;
    outcome: "verified";
    method: string;
  }>;
  job?: DurableJobEvidence;
  outputs?: StableOutputEvidence[];
}

export interface ProgramVerificationResult {
  status: "verified" | "unverified" | "blocked_external" | "reconciliation_required";
  method: string;
  reasons: string[];
}
