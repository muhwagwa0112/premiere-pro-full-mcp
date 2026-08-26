#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeClient } from "./bridge/ws-client.js";
import { createMcpServer } from "./server.js";
import { WsHost, DEFAULT_DAEMON_PORT, readBridgeEndpoint } from "./bridge/ws-host.js";

/**
 * MCP stdio server entry point.
 *
 * Connects to the always-on bridge daemon (which is either already running or
 * started here if the port is free) and serves the full tool surface to the
 * agent. Premiere's CEP extension connects to the same daemon independently,
 * so the bridge is always ready once Premiere is open — no manual setup.
 */
async function main(): Promise<void> {
  // Ensure the daemon is up. If it is already listening (started at logon),
  // connect to it as a client; otherwise start it in-process for this session.
  const existing = readBridgeEndpoint();
  let connectedToDaemon = false;
  if (existing && existing.port === DEFAULT_DAEMON_PORT) {
    try {
      const probe = await BridgeClient.connect(existing.port);
      await probe.close();
      connectedToDaemon = true;
    } catch {
      // Stale endpoint file — daemon is not actually reachable. Start fresh.
    }
  }

  if (!connectedToDaemon) {
    try {
      await WsHost.start(DEFAULT_DAEMON_PORT);
      connectedToDaemon = true;
    } catch (error) {
      // Another process bound the port (a real daemon). Use it as a client.
      connectedToDaemon = true;
    }
  }

  const bridge = await BridgeClient.connect(DEFAULT_DAEMON_PORT);
  const server = createMcpServer(bridge);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`[premiere-pro-full-mcp] connected to bridge ws://127.0.0.1:${bridge.port}/bridge\n`);
  process.stderr.write("[premiere-pro-full-mcp] ready\n");
}

main().catch((error) => {
  process.stderr.write(`[premiere-pro-full-mcp] fatal: ${error.stack ?? String(error)}\n`);
  process.exit(1);
});
