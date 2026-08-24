import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { ConnectorBoundary, ConnectorBoundaryError, executeConnectorOnce } from "../src/connectors/boundary.js";
import type { ConnectorHandler, ConnectorRequest } from "../src/connectors/contracts.js";
import { connectorDefinitions } from "../src/connectors/registry.js";
import { collaborationBoundaryFeatures } from "../src/features/collaboration/boundaries.js";

const request: ConnectorRequest = {
  protocolVersion: 1,
  requestId: "request-1",
  operation: "external.example.v1",
  args: {},
  capabilityFingerprint: "a".repeat(64),
};

describe("connector boundaries", () => {
  it("truthfully exposes boundary-only external features with explicit dependencies", () => {
    expect(connectorDefinitions).toHaveLength(5);
    expect(collaborationBoundaryFeatures).toHaveLength(5);
    expect(connectorDefinitions.every((entry) => entry.support === "unsupported_external" && entry.implementation === "boundary_only" && entry.operations.length === 0)).toBe(true);
    expect(connectorDefinitions.every((entry) => entry.entitlement.required === (entry.entitlement.kind !== "none"))).toBe(true);
    expect(connectorDefinitions.find((entry) => entry.id === "third_party_plugin")?.plugins).toEqual([
      expect.objectContaining({ pluginId: "connector-supplied", required: true, verification: "runtime_probe" }),
    ]);
  });

  it("has no secret extraction or secret-bearing request surface", async () => {
    const source = await readFile(new URL("../src/connectors/contracts.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/getAccessToken|refreshToken|clientSecret|password|exportCredentials/i);
    expect(Object.keys(request)).toEqual(["protocolVersion", "requestId", "operation", "args", "capabilityFingerprint"]);
  });

  it("fails closed before dispatch when a handler or declared operation is absent", async () => {
    const boundary = new ConnectorBoundary();
    await expect(boundary.execute("productions", request)).rejects.toMatchObject({ code: "CONNECTOR_HANDLER_MISSING" } satisfies Partial<ConnectorBoundaryError>);

    const execute = vi.fn();
    expect(() => boundary.register({
      id: "productions",
      probe: async () => ({ available: true, protocolVersion: 1, operations: [request.operation], entitlementSatisfied: true, installedPlugins: {}, capabilityFingerprint: "fixture" }),
      execute,
    })).toThrow(expect.objectContaining({ code: "CONNECTOR_NOT_ACTIVATED" }));
    expect(execute).not.toHaveBeenCalled();
  });

  it("dispatches once and converts an unverified mutation to unknown without retry", async () => {
    const execute = vi.fn(async () => ({
      protocolVersion: 1 as const,
      requestId: request.requestId,
      ok: true,
      dispatchState: "completed" as const,
      verified: false,
    }));
    const handler: ConnectorHandler = { id: "productions", probe: async () => { throw new Error("unused"); }, execute };
    await expect(executeConnectorOnce(handler, request, true)).resolves.toMatchObject({
      ok: false,
      dispatchState: "unknown",
      error: { code: "POSTCONDITION_NOT_VERIFIED" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects nested secret-bearing arguments before connector dispatch", async () => {
    const execute = vi.fn();
    const handler: ConnectorHandler = { id: "frame_io", probe: async () => { throw new Error("unused"); }, execute };
    await expect(executeConnectorOnce(handler, { ...request, args: { nested: { accessToken: "must-not-cross" } } }, true)).rejects.toMatchObject({
      code: "SECRET_MATERIAL_FORBIDDEN",
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
