import type { ConnectorDefinition, ConnectorId } from "./contracts.js";

export const connectorDefinitions: readonly ConnectorDefinition[] = [
  {
    id: "productions",
    title: "Premiere Productions",
    protocolVersion: 1,
    support: "unsupported_external",
    implementation: "boundary_only",
    operations: [],
    mutatingOperations: [],
    entitlement: { kind: "none", product: null, required: false, verification: "not_required" },
    plugins: [],
    limitations: ["No typed Productions handler is installed", "A live Productions workspace probe is required before support can be claimed"],
  },
  {
    id: "team_projects",
    title: "Adobe Team Projects",
    protocolVersion: 1,
    support: "unsupported_external",
    implementation: "boundary_only",
    operations: [],
    mutatingOperations: [],
    entitlement: { kind: "host_managed", product: "Adobe Team Projects", required: true, verification: "runtime_probe" },
    plugins: [],
    limitations: ["No typed Team Projects handler is installed", "Entitlement and signed-in host state must be probed at runtime"],
  },
  {
    id: "frame_io",
    title: "Frame.io",
    protocolVersion: 1,
    support: "unsupported_external",
    implementation: "boundary_only",
    operations: [],
    mutatingOperations: [],
    entitlement: { kind: "external_subscription", product: "Frame.io", required: true, verification: "runtime_probe" },
    plugins: [],
    limitations: ["No Frame.io service handler is installed", "Authentication remains owned by Frame.io or the Adobe host integration"],
  },
  {
    id: "adobe_services",
    title: "Adobe cloud services",
    protocolVersion: 1,
    support: "unsupported_external",
    implementation: "boundary_only",
    operations: [],
    mutatingOperations: [],
    entitlement: { kind: "host_managed", product: "Adobe Creative Cloud service", required: true, verification: "runtime_probe" },
    plugins: [],
    limitations: ["No Adobe service handler is installed", "Service-specific entitlement and capability probes are required"],
  },
  {
    id: "third_party_plugin",
    title: "Third-party Premiere plugin",
    protocolVersion: 1,
    support: "unsupported_external",
    implementation: "boundary_only",
    operations: [],
    mutatingOperations: [],
    entitlement: { kind: "external_subscription", product: "Plugin-defined entitlement", required: true, verification: "runtime_probe" },
    plugins: [{ pluginId: "connector-supplied", minimumVersion: null, required: true, verification: "runtime_probe" }],
    limitations: ["No arbitrary plugin invocation is exposed", "An integrity-pinned native contract and exact plugin dependency are required"],
  },
] as const;

const byId = new Map<ConnectorId, ConnectorDefinition>(connectorDefinitions.map((definition) => [definition.id, definition]));

export function connectorDefinition(id: ConnectorId): ConnectorDefinition {
  const definition = byId.get(id);
  if (!definition) throw new Error(`Unknown connector '${id as string}'`);
  return definition;
}
