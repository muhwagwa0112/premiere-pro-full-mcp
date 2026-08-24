import type { ConnectorId, ConnectorSupport, EntitlementDependency, PluginDependency } from "../../connectors/contracts.js";
import { connectorDefinitions } from "../../connectors/registry.js";

export interface CollaborationBoundaryFeature {
  featureId: string;
  connector: ConnectorId;
  support: ConnectorSupport;
  implementation: "boundary_only";
  entitlement: EntitlementDependency;
  plugins: readonly PluginDependency[];
  operations: readonly string[];
  limitations: readonly string[];
}

/**
 * Public boundary inventory. These are intentionally not ActionDescriptors:
 * registering an MCP action before a typed runtime handler exists would claim
 * support that the repository cannot currently prove.
 */
export const collaborationBoundaryFeatures: readonly CollaborationBoundaryFeature[] = connectorDefinitions.map((definition) => ({
  featureId: `collaboration.${definition.id}`,
  connector: definition.id,
  support: definition.support,
  implementation: "boundary_only",
  entitlement: definition.entitlement,
  plugins: definition.plugins,
  operations: definition.operations,
  limitations: definition.limitations,
}));

