import type {
  ConnectorDefinition,
  ConnectorHandler,
  ConnectorId,
  ConnectorProbe,
  ConnectorRequest,
  ConnectorResponse,
  PluginDependency,
} from "./contracts.js";
import { connectorDefinition } from "./registry.js";

export class ConnectorBoundaryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ConnectorBoundaryError";
  }
}

function assertNoSecretMaterial(value: unknown, depth = 0): void {
  if (depth > 12) throw new ConnectorBoundaryError("CONNECTOR_ARGUMENT_DEPTH", "Connector arguments exceed the allowed nesting depth");
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretMaterial(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(credential|password|secret|token|authorization|api.?key|cookie|session|private.?key)/i.test(key)) {
      throw new ConnectorBoundaryError("SECRET_MATERIAL_FORBIDDEN", `Connector argument '${key}' is forbidden; authentication must remain inside the owning integration`);
    }
    assertNoSecretMaterial(child, depth + 1);
  }
}

export async function executeConnectorOnce(handler: ConnectorHandler, request: ConnectorRequest, mutates: boolean): Promise<ConnectorResponse> {
  if (Buffer.byteLength(JSON.stringify(request.args), "utf8") > 64 * 1024) throw new ConnectorBoundaryError("CONNECTOR_ARGUMENT_SIZE", "Connector arguments exceed 64 KiB");
  assertNoSecretMaterial(request.args);
  const response = await handler.execute(request);
  if (response.protocolVersion !== 1 || response.requestId !== request.requestId) throw new ConnectorBoundaryError("CONNECTOR_RESPONSE_MISMATCH", "Connector response is not bound to the request");
  if (mutates && response.ok && response.dispatchState === "completed" && !response.verified) {
    return {
      ...response,
      ok: false,
      dispatchState: "unknown",
      error: { code: "POSTCONDITION_NOT_VERIFIED", message: "Connector mutation completed without verified postconditions" },
    };
  }
  return response;
}

function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10)).map((part) => Number.isFinite(part) ? part : 0);
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = versionParts(actual);
  const right = versionParts(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function dependencySatisfied(dependency: PluginDependency, installed: Readonly<Record<string, string>>): boolean {
  if (!dependency.required) return true;
  if (dependency.pluginId === "connector-supplied") return Object.keys(installed).length > 0;
  const version = installed[dependency.pluginId];
  return version !== undefined && (dependency.minimumVersion === null || versionAtLeast(version, dependency.minimumVersion));
}

function assertProbe(definition: ConnectorDefinition, probe: ConnectorProbe, operation: string): void {
  if (probe.protocolVersion !== definition.protocolVersion) throw new ConnectorBoundaryError("CONNECTOR_PROTOCOL_MISMATCH", "Connector protocol version is not supported");
  if (!probe.available) throw new ConnectorBoundaryError("CONNECTOR_UNAVAILABLE", probe.reason ?? "Connector runtime is unavailable");
  if (definition.entitlement.required && !probe.entitlementSatisfied) throw new ConnectorBoundaryError("ENTITLEMENT_REQUIRED", `${definition.entitlement.product ?? definition.title} entitlement was not verified`);
  for (const dependency of definition.plugins) {
    if (!dependencySatisfied(dependency, probe.installedPlugins)) throw new ConnectorBoundaryError("PLUGIN_DEPENDENCY_MISSING", `Required plugin '${dependency.pluginId}' was not verified`);
  }
  if (!definition.operations.includes(operation) || !probe.operations.includes(operation)) throw new ConnectorBoundaryError("CONNECTOR_OPERATION_UNSUPPORTED", `Operation '${operation}' is not supported by both the declared boundary and runtime probe`);
}

export class ConnectorBoundary {
  readonly #handlers = new Map<ConnectorId, ConnectorHandler>();

  register(handler: ConnectorHandler): void {
    if (this.#handlers.has(handler.id)) throw new ConnectorBoundaryError("CONNECTOR_ALREADY_REGISTERED", `Connector '${handler.id}' is already registered`);
    const definition = connectorDefinition(handler.id);
    if (definition.implementation !== "handler_registered") throw new ConnectorBoundaryError("CONNECTOR_NOT_ACTIVATED", `Connector '${handler.id}' is boundary-only and cannot register an executable handler`);
    this.#handlers.set(handler.id, handler);
  }

  async probe(id: ConnectorId): Promise<ConnectorProbe> {
    const handler = this.#handlers.get(id);
    if (!handler) {
      return {
        available: false,
        protocolVersion: 1,
        operations: [],
        entitlementSatisfied: false,
        installedPlugins: {},
        capabilityFingerprint: null,
        reason: "No connector handler is registered",
      };
    }
    return handler.probe();
  }

  async execute(id: ConnectorId, request: ConnectorRequest): Promise<ConnectorResponse> {
    const definition = connectorDefinition(id);
    const handler = this.#handlers.get(id);
    if (!handler) throw new ConnectorBoundaryError("CONNECTOR_HANDLER_MISSING", `No handler is registered for '${id}'`);
    const probe = await handler.probe();
    assertProbe(definition, probe, request.operation);
    if (!probe.capabilityFingerprint || !/^[a-f0-9]{64}$/i.test(probe.capabilityFingerprint) || request.capabilityFingerprint !== probe.capabilityFingerprint) throw new ConnectorBoundaryError("CONNECTOR_ROUTE_BINDING_MISMATCH", "Connector request is not bound to the exact runtime capability fingerprint");

    // Exactly one dispatch attempt. Accepted/unknown outcomes are surfaced for
    // reconciliation and are never retried by this boundary.
    return executeConnectorOnce(handler, request, definition.mutatingOperations.includes(request.operation));
  }
}
