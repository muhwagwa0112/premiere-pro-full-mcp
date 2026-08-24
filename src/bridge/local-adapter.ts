import { randomUUID } from "node:crypto";
import { collectLocalInventory } from "../inventory.js";
import type { BackendAdapter, BackendProbe, BridgeRequest, BridgeResponse, SupportDecision } from "../contracts.js";
import { searchAdobeApiCatalog } from "../adobe-api-catalog.js";

export class LocalAdapter implements BackendAdapter {
  readonly backend = "local" as const;
  static readonly operations = ["host.inspect", "plugin.catalog", "effects.catalog", "uxp.catalog"] as const;

  async probe(): Promise<BackendProbe> {
    return { backend: this.backend, available: true, hostVersion: "26.3.2-target", operations: LocalAdapter.operations };
  }

  async supports(operation: string, _context: Record<string, unknown>): Promise<SupportDecision> {
    return LocalAdapter.operations.includes(operation as (typeof LocalAdapter.operations)[number])
      ? { supported: true, state: "verified" }
      : { supported: false, state: "unsupported", reason: `Local adapter does not implement ${operation}` };
  }

  async availability(): Promise<{ available: boolean; hostVersion?: string }> {
    return { available: true, hostVersion: "26.3.2-target" };
  }

  async execute(request: BridgeRequest): Promise<BridgeResponse> {
    if (!["host.inspect", "plugin.catalog", "effects.catalog", "uxp.catalog"].includes(request.operation)) {
      return this.failure(request, "LOCAL_OPERATION_UNSUPPORTED", `Local adapter does not implement ${request.operation}`);
    }
    if (request.operation === "uxp.catalog") {
      return {
        protocolVersion: 1,
        requestId: request.requestId,
        ok: true,
        dispatchState: "completed",
        hostVersion: "26.3.2-target",
        verification: { outcome: "verified", method: "generated Adobe declaration catalog" },
        result: await searchAdobeApiCatalog(request.args),
      };
    }
    const inventory = await collectLocalInventory();
    const result = request.operation === "host.inspect"
      ? {
          supportedHost: inventory.supportedHost,
          platform: inventory.platform,
          architecture: inventory.architecture,
          pluginCounts: inventory.counts,
          inventoryRevision: inventory.revision,
          connectedHost: false,
        }
      : request.operation === "effects.catalog"
        ? { revision: inventory.revision, effects: inventory.plugins.filter((plugin) => plugin.kind === "effect") }
        : { revision: inventory.revision, plugins: inventory.plugins, counts: inventory.counts, warnings: inventory.warnings };
    return {
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      dispatchState: "completed",
      hostVersion: inventory.supportedHost.expectedVersion,
      afterRevision: inventory.revision,
      verification: { outcome: "verified", method: "read-only local inventory" },
      result,
    };
  }

  private failure(request: BridgeRequest, code: string, message: string): BridgeResponse {
    return { protocolVersion: 1, requestId: request.requestId || randomUUID(), ok: false, dispatchState: "not_dispatched", error: { code, message, retryable: false } };
  }
}
