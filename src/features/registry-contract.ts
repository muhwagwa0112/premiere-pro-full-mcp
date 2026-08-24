export const FEATURE_STATUSES = [
  "VERIFIED_AUTOMATED", "VERIFIED_READ_ONLY", "SUPPORTED_CONTEXTUAL", "PREVIEW_ONLY",
  "UI_ADAPTER_REQUIRED", "EXTERNAL_SERVICE_REQUIRED", "ENTITLEMENT_BLOCKED",
  "THIRD_PARTY_DEPENDENT", "MANUAL_ONLY", "BLOCKED_BY_HOST_VERSION", "UNVERIFIED", "UNSUPPORTED",
] as const;

export const FEATURE_BACKENDS = ["local", "uxp", "cep", "qe", "ui", "native", "service"] as const;

export type FeatureStatus = typeof FEATURE_STATUSES[number];
export type FeatureBackend = typeof FEATURE_BACKENDS[number];

export interface FeatureRegistryEntry {
  featureId: string;
  domain: string;
  title: string;
  status: FeatureStatus;
  backends: FeatureBackend[];
  risk: "R0" | "R1" | "R2" | "R3";
  minimumPremiereVersion: string | null;
  maximumPremiereVersion: string | null;
  preconditions: string[];
  verification: string[];
  fixture: string | null;
  limitations: string[];
}

export interface FeatureSpec {
  id: string;
  title: string;
  status: FeatureStatus;
  backends: readonly FeatureBackend[];
  risk: FeatureRegistryEntry["risk"];
  preconditions: readonly string[];
  verification: readonly string[];
  fixture?: string | null;
  limitations?: readonly string[];
  minimumPremiereVersion?: string | null;
  maximumPremiereVersion?: string | null;
}

export function defineDomain(domain: string, specs: readonly FeatureSpec[]): FeatureRegistryEntry[] {
  return specs.map((spec) => ({
    featureId: spec.id,
    domain,
    title: spec.title,
    status: spec.status,
    backends: [...spec.backends],
    risk: spec.risk,
    minimumPremiereVersion: spec.minimumPremiereVersion === undefined ? "26.3.0" : spec.minimumPremiereVersion,
    maximumPremiereVersion: spec.maximumPremiereVersion ?? null,
    preconditions: [...spec.preconditions],
    verification: [...spec.verification],
    fixture: spec.fixture ?? null,
    limitations: [...(spec.limitations ?? ["No live v0.3 evidence has been recorded for this feature family."])],
  }));
}

export const state = {
  inspect: ["connected host session"],
  project: ["active disposable project", "matching scoped state token"],
  sequence: ["active disposable sequence", "matching scoped state token"],
  entitlement: ["authenticated account", "required entitlement", "explicit service authorization"],
} as const;

export const verify = {
  inspect: ["typed host readback"],
  revision: ["targeted object readback", "project or sequence revision transition"],
  file: ["canonical output path", "stable non-empty file"],
  service: ["service receipt", "host-visible state readback"],
} as const;
