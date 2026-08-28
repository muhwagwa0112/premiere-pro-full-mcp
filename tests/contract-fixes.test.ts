import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer, type BridgeClient } from "../src/server.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

function bridge(executed: string[] = []): BridgeClient {
  return {
    connected: true,
    port: 48210,
    executeScript: async (script) => {
      executed.push(script);
      return { success: true, data: { ok: true } };
    },
    uxp: async () => ({ success: false, code: "UXP_MOCK", error: "mock" }),
    probeHost: async () => ({ responsive: true }),
    operationStatus: async () => ({ quarantined: false, unresolved: [], reconciliation: [] }),
  };
}

async function connected(bridgeClient: BridgeClient): Promise<Client> {
  const server = createMcpServer(bridgeClient);
  const client = new Client({ name: "contract-fixes", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanup.push(() => client.close(), () => server.close());
  return client;
}

describe("public contract fixes", () => {
  it("registers health and connection status with exactly one public prefix", async () => {
    const client = await connected(bridge());
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain("premiere_health_check");
    expect(names).toContain("premiere_connection_status");
    expect(names).not.toContain("premiere_premiere_health_check");
    expect(names).not.toContain("premiere_premiere_connection_status");
  });

  it("publishes policy-aligned queue and execution timeouts for FCP XML and frame export", async () => {
    const client = await connected(bridge());
    const tools = (await client.listTools()).tools;
    const xml = tools.find((entry) => entry.name === "premiere_import_fcp_xml");
    const xmlProperties = xml?.inputSchema.properties as Record<string, { maximum?: number }>;
    expect(xmlProperties.timeout_ms?.maximum).toBe(300_000);
    expect(xmlProperties.queue_timeout_ms?.maximum).toBe(120_000);
    const frame = tools.find((entry) => entry.name === "premiere_export_frame");
    const frameProperties = frame?.inputSchema.properties as Record<string, { maximum?: number }>;
    expect(frameProperties.timeout_ms?.maximum).toBe(120_000);
    expect(frameProperties.queue_timeout_ms?.maximum).toBe(120_000);
  });

  it("maps each truthful bounded batch relink entry to the singular upstream handler", async () => {
    const executed: string[] = [];
    const client = await connected(bridge(executed));
    const result = await client.callTool({
      name: "premiere_media_batch_relink",
      arguments: {
        relinks: [
          { project_item_id: "item-a", new_path: "D:\\media\\a.wav" },
          { project_item_id: "item-b", new_path: "D:\\media\\b.wav" },
        ],
      },
    });

    expect(result.structuredContent).toMatchObject({ success: true, requested: 2, completed: 2, failed: 0 });
    expect(executed).toHaveLength(2);
    expect(executed[0]).toContain("item-a");
    expect(executed[1]).toContain("item-b");
  });

  it("advertises only the compound batch relink input instead of ignored legacy fields", async () => {
    const client = await connected(bridge());
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "premiere_media_batch_relink");
    const properties = tool?.inputSchema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("relinks");
    expect(properties).not.toHaveProperty("project_item_id");
    expect(properties).not.toHaveProperty("paths");
  });

  it("returns the same read-only recovery status through health and connection diagnostics", async () => {
    const client = await connected(bridge());
    const connection = await client.callTool({ name: "premiere_connection_status", arguments: {} });
    const health = await client.callTool({ name: "premiere_health_check", arguments: {} });
    const connectionContent = connection.structuredContent as Record<string, unknown>;
    const healthContent = health.structuredContent as Record<string, unknown>;

    expect(connectionContent.recovery_status).toMatchObject({ quarantined: false, unresolved: [] });
    expect(healthContent.recovery_status).toMatchObject({ quarantined: false, unresolved: [] });
  });

  it("makes raw-script read mode an explicit, validated opt-in", async () => {
    const modes: string[] = [];
    const bridgeClient: BridgeClient = {
      ...bridge(),
      beginOperation: async (request) => { modes.push(request.mode); return request.operationId; },
      endOperation: async () => undefined,
    };
    const client = await connected(bridgeClient);

    const allowed = await client.callTool({
      name: "premiere_execute_extendscript",
      arguments: { code: "return __result({ projectName: app.project.name });", read_only: true },
    });
    expect(allowed.isError).not.toBe(true);
    expect(modes).toEqual(["read"]);

    const rejected = await client.callTool({
      name: "premiere_execute_extendscript",
      arguments: { code: "app.project.save(); return __result({});", read_only: true },
    });
    expect(rejected.isError).toBe(true);
    expect(modes).toEqual(["read"]);
  });

  it("reads a recovery fingerprint without triggering acknowledgement", async () => {
    const client = await connected({
      ...bridge(),
      recoverySnapshot: async (operationId) => ({ operationId, observedFingerprint: "a".repeat(64), comparison: "CHANGED_FROM_PRE" }),
    });
    const result = await client.callTool({
      name: "premiere_health_check",
      arguments: { mode: "recovery_snapshot", recovery_operation_id: "00000000-0000-4000-8000-000000000001" },
    });
    expect(result.structuredContent).toMatchObject({ observedFingerprint: "a".repeat(64), comparison: "CHANGED_FROM_PRE" });
  });

  it("routes sequence creation to the Premiere 26 UXP operation", async () => {
    const operations: Array<{ operation: string; args?: Record<string, unknown> }> = [];
    const timeouts: Array<number | undefined> = [];
    const client = await connected({
      ...bridge(),
      uxp: async (operation, args, _expectedRevision, _operationMetadata, timeoutMs) => {
        operations.push(args === undefined ? { operation } : { operation, args });
        timeouts.push(timeoutMs);
        return {
          beforeRevision: "before",
          afterRevision: "after",
          verification: { outcome: "verified", method: "readback" },
          result: { created: true, name: "CUT_03", sequenceGuid: "guid-3", presetPath: "D:\\presets\\hd.sqpreset" },
        };
      },
    });
    const result = await client.callTool({ name: "premiere_create_sequence", arguments: { name: "CUT_03", preset_path: "D:\\presets\\hd.sqpreset", timeout_ms: 60_000 } });
    expect(result.structuredContent).toMatchObject({ created: true, sequenceGuid: "guid-3" });
    expect(result.structuredContent).toHaveProperty("uxpVerification.verification.outcome", "verified");
    expect(operations).toEqual([{ operation: "project.sequence.create", args: { name: "CUT_03", presetPath: "D:\\presets\\hd.sqpreset" } }]);
    expect(timeouts).toEqual([60_000]);
  });

  it("creates a Premiere 26 sequence with the host default preset when none is supplied", async () => {
    const operations: Array<{ operation: string; args?: Record<string, unknown> }> = [];
    const client = await connected({
      ...bridge(),
      uxp: async (operation, args) => {
        operations.push(args === undefined ? { operation } : { operation, args });
        return { success: true, data: { created: true, name: "CUT_DEFAULT", sequenceGuid: "guid-default", presetPath: null } };
      },
    });
    const result = await client.callTool({ name: "premiere_create_sequence", arguments: { name: "CUT_DEFAULT" } });
    expect(result.structuredContent).toMatchObject({ created: true, sequenceGuid: "guid-default" });
    expect(operations).toEqual([{ operation: "project.sequence.create", args: { name: "CUT_DEFAULT" } }]);
  });

  it("uses the current UXP playhead when export_frame omits time_seconds", async () => {
    const operations: Array<{ operation: string; args?: Record<string, unknown> }> = [];
    const client = await connected({
      ...bridge(),
      uxp: async (operation, args) => {
        operations.push(args === undefined ? { operation } : { operation, args });
        return {
          beforeRevision: "before",
          afterRevision: "before",
          verification: { outcome: "verified", method: "stable file" },
          result: { exported: true, outputPath: "D:\\frames\\still.png", requestedSeconds: null, timeSource: "current-playhead", resolvedSeconds: 12, resolvedFrame: 360, fps: 30 },
        };
      },
    });
    const result = await client.callTool({ name: "premiere_export_frame", arguments: { output_path: "D:\\frames\\still.png" } });
    expect(result.structuredContent).toMatchObject({ exported: true, timeSource: "current-playhead", resolvedFrame: 360 });
    expect(operations[0]).toMatchObject({ operation: "export.frame", args: { outputPath: "D:\\frames\\still.png" } });
    expect(Object.prototype.hasOwnProperty.call(operations[0]?.args ?? {}, "timeSeconds")).toBe(false);
  });
});
