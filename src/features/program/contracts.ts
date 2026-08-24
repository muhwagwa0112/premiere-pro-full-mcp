export const POST_PRODUCTION_DOMAINS = ["effects", "audio", "text", "captions", "color", "export"] as const;

export type PostProductionDomain = typeof POST_PRODUCTION_DOMAINS[number];
export type ProgramAvailability =
  | "handler_unverified"
  | "not_implemented"
  | "ui_adapter_required"
  | "blocked_external"
  | "third_party_dependent"
  | "blocked_host_version";

export interface EntitlementRequirement {
  key: string;
  product: string;
  probe: "runtime_entitlement_probe";
}

export interface ProgramFeatureContract {
  actionId: string;
  domain: PostProductionDomain;
  availability: ProgramAvailability;
  mutatesProject: boolean;
  exportsFile: boolean;
  executionSurface: "premiere_operations" | "premiere_jobs";
  entitlement: EntitlementRequirement | null;
  evidenceState: "none";
  limitations: string[];
}

export interface ProgramWorkflowContract {
  workflowId: string;
  domains: PostProductionDomain[];
  kind: "compound_mutation" | "compound_export";
  availability: "plan_only" | "implemented_unverified";
  executionSurface: "premiere_jobs";
  requiredActions: string[];
  requiresDurableJobRecord: true;
  requiresVerifiedCheckpoint: true;
  checkpointPolicy: "trusted_profile_before_first_mutation_and_nonundoable";
  requiresVerifiedPostWorkflowCheckpointEvidence: true;
  unknownDispatchOutcome: "reconciliation_required";
  automaticRedispatchAfterUnknownOutcome: false;
}

export interface ProgramBlockResult {
  status: "blocked_external" | "unsupported" | "ready_unverified";
  error?: {
    code: "ENTITLEMENT_NOT_VERIFIED" | "HANDLER_NOT_IMPLEMENTED" | "UI_ADAPTER_REQUIRED" | "HOST_VERSION_BLOCKED" | "THIRD_PARTY_DEPENDENCY";
    message: string;
  };
}

export interface ProgramRuntimeReadiness {
  advertisedHandlers: readonly string[];
  verifiedEntitlements: readonly string[];
  registeredUiAdapters?: readonly string[];
}
