// Reference contract. Adapt to repository style; do not copy blindly.
export type DispatchState = "not_dispatched" | "accepted" | "completed" | "unknown";

export interface BackendProbe {
  backend: string;
  available: boolean;
  hostVersion?: string;
  hostSessionId?: string;
  capabilityFingerprint?: string;
  operations: readonly string[];
  reason?: string;
}

export interface SupportDecision {
  supported: boolean;
  state: "verified" | "implemented_unverified" | "contextual" | "experimental" | "unsupported";
  reason?: string;
  requiredState?: readonly string[];
}

export interface CapabilityAwareBackendAdapter {
  readonly backend: string;
  probe(): Promise<BackendProbe>;
  supports(operation: string, context: Record<string, unknown>): Promise<SupportDecision>;
  execute(request: unknown): Promise<{ ok: boolean; dispatchState: DispatchState }>;
}
