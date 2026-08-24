import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import type { OperationEngine } from "../src/operation-engine.js";

describe("public MCP request schema", () => {
  const close: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(close.splice(0).map((callback) => callback())); });

  it("exposes planHash on every typed action tool", async () => {
    const engine = {
      capabilities: async () => ({}),
      execute: async () => { throw new Error("not used"); },
      preview: async () => { throw new Error("not used"); },
      status: async () => ({}),
    } as unknown as OperationEngine;
    const server = createServer(engine);
    const client = new Client({ name: "schema-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close.push(() => client.close(), () => server.close());

    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === "premiere_jobs")?.inputSchema).toMatchObject({
      required: ["mode"],
      properties: { mode: { enum: ["plan", "workflow_plan", "execute", "status", "cancel", "resume", "rollback"] } },
    });
    const typedTools = tools.tools.filter((tool) => tool.name.startsWith("premiere_") && !["premiere_capabilities", "premiere_operations", "premiere_jobs"].includes(tool.name));
    expect(typedTools.length).toBeGreaterThan(0);
    for (const tool of typedTools) {
      expect(tool.inputSchema).toMatchObject({
        properties: { planHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } },
      });
    }

    const resources = await client.listResources();
    expect(resources.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: "premiere://features", name: "premiere-feature-registry" }),
    ]));
    const registry = await client.readResource({ uri: "premiere://features" });
    const entries = JSON.parse((registry.contents[0] as { text: string }).text) as Array<{ featureId: string; status: string }>;
    expect(entries.length).toBeGreaterThan(100);
    expect(entries.find((entry) => entry.featureId === "timeline.clip.insert")?.status).toBe("SUPPORTED_CONTEXTUAL");
  });
});
