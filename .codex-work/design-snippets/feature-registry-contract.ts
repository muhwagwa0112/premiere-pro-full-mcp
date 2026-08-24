export type FeatureStatus =
  | "VERIFIED_AUTOMATED"
  | "VERIFIED_READ_ONLY"
  | "SUPPORTED_CONTEXTUAL"
  | "PREVIEW_ONLY"
  | "UI_ADAPTER_REQUIRED"
  | "EXTERNAL_SERVICE_REQUIRED"
  | "ENTITLEMENT_BLOCKED"
  | "THIRD_PARTY_DEPENDENT"
  | "MANUAL_ONLY"
  | "BLOCKED_BY_HOST_VERSION"
  | "UNVERIFIED"
  | "UNSUPPORTED";

export interface FeatureRegistryEntry {
  featureId: string;
  domain: string;
  title: string;
  status: FeatureStatus;
  backends: readonly string[];
  risk: "R0" | "R1" | "R2" | "R3";
  minimumPremiereVersion?: string;
  maximumPremiereVersion?: string;
  preconditions: readonly string[];
  verification: readonly string[];
  fixture?: string;
  limitations: readonly string[];
}
