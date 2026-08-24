import { z } from "zod";

export const connectorIdSchema = z.enum([
  "productions",
  "team_projects",
  "frame_io",
  "adobe_services",
  "third_party_plugin",
]);
export type ConnectorId = z.infer<typeof connectorIdSchema>;

export const connectorSupportSchema = z.enum([
  "unsupported_external",
  "implemented_unverified",
  "verified",
]);
export type ConnectorSupport = z.infer<typeof connectorSupportSchema>;

export interface EntitlementDependency {
  kind: "none" | "host_managed" | "external_subscription";
  product: string | null;
  required: boolean;
  verification: "not_required" | "runtime_probe";
}

export interface PluginDependency {
  pluginId: string;
  minimumVersion: string | null;
  required: boolean;
  verification: "runtime_probe";
}

export interface ConnectorDefinition {
  id: ConnectorId;
  title: string;
  protocolVersion: 1;
  support: ConnectorSupport;
  implementation: "boundary_only" | "handler_registered";
  operations: readonly string[];
  mutatingOperations: readonly string[];
  entitlement: EntitlementDependency;
  plugins: readonly PluginDependency[];
  limitations: readonly string[];
}

export interface ConnectorProbe {
  available: boolean;
  protocolVersion: 1;
  operations: readonly string[];
  entitlementSatisfied: boolean;
  installedPlugins: Readonly<Record<string, string>>;
  capabilityFingerprint: string | null;
  reason?: string;
}

export interface ConnectorRequest {
  protocolVersion: 1;
  requestId: string;
  operation: string;
  args: Readonly<Record<string, unknown>>;
  capabilityFingerprint: string;
}

export interface ConnectorResponse {
  protocolVersion: 1;
  requestId: string;
  ok: boolean;
  dispatchState: "not_dispatched" | "accepted" | "completed" | "unknown";
  verified: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/**
 * Implementations authenticate inside their owning host/service integration. The
 * MCP process is deliberately given neither an authentication-export method nor
 * a secret-bearing request field.
 */
export interface ConnectorHandler {
  readonly id: ConnectorId;
  probe(): Promise<ConnectorProbe>;
  execute(request: ConnectorRequest): Promise<ConnectorResponse>;
}
