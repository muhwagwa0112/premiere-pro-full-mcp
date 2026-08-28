import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer, type BridgeClient } from "../src/server.js";
import { ALL_TOOL_NAMES } from "../src/tool-names.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(close.splice(0).map((cb) => cb())); });

function mockHost(): BridgeClient {
  return {
    connected: true,
    port: 4242,
    executeScript: async (script) => ({ echo: { script } }),
    uxp: async (operation, args) => ({ success: false, error: "mock uxp", code: "UXP_MOCK" }),
  };
}

async function listToolNames(client: Client): Promise<string[]> {
  const tools = await client.listTools();
  return tools.tools.map((t) => t.name);
}

describe("rebuilt MCP server", () => {
  it("registers every catalogued tool as its own flat tool", async () => {
    const server = createMcpServer(mockHost());
    const client = new Client({ name: "rebuild-test", version: "1.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    close.push(() => client.close(), () => server.close());

    const names = await listToolNames(client);
    expect(names.length).toBeGreaterThanOrEqual(ALL_TOOL_NAMES.length + 1);
    for (const tool of ALL_TOOL_NAMES) {
      expect(names).toContain(tool.startsWith("premiere_") ? tool : `premiere_${tool}`);
    }
  });

  it("never asks the agent for an actionId", async () => {
    const server = createMcpServer(mockHost());
    const client = new Client({ name: "rebuild-test", version: "1.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    close.push(() => client.close(), () => server.close());

    const tools = await client.listTools();
    for (const tool of tools.tools) {
      if (!tool.name.startsWith("premiere_")) continue;
      const props = (tool.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
      expect(Object.keys(props)).not.toContain("actionId");
      expect(Object.keys(props)).not.toContain("planHash");
    }
  });

  it("advertises the compatible FCP XML output-directory contract", async () => {
    const server = createMcpServer(mockHost());
    const client = new Client({ name: "rebuild-test", version: "1.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    close.push(() => client.close(), () => server.close());

    const tool = (await client.listTools()).tools.find((entry) => entry.name === "premiere_import_fcp_xml");
    expect(tool).toBeTruthy();
    expect(tool?.inputSchema.required).toEqual(["path", "output_directory"]);
    expect(tool?.inputSchema.properties).toHaveProperty("output_directory");
    expect(tool?.inputSchema.properties).not.toHaveProperty("project_path");
  });
});
