#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeClient } from "./bridge/ws-client.js";
import { createMcpServer } from "./server.js";
import { DEFAULT_DAEMON_PORT, readBridgeEndpoint } from "./bridge/ws-host.js";

/**
 * MCP stdio server entry point.
 *
 * Connects to the always-on bridge daemon (which is either already running or
 * started here if the port is free) and serves the full tool surface to the
 * agent. Premiere's CEP extension connects to the same daemon independently,
 * so the bridge is always ready once Premiere is open — no manual setup.
 */
async function main(): Promise<void> {
  // Connect to the always-on bridge daemon. The daemon is a separate,
  // long-lived `dist/daemon.js` process (auto-started at logon). It must
  // NEVER be self-hosted from inside this MCP server entry point: if the MCP
  // server process owns the fixed port, the "daemon" dies whenever that
  // client session ends, leaving a stale bridge-endpoint that other sessions
  // read and then fail to reach. Connect as a client only.
  const existing = readBridgeEndpoint();
  if (!existing || existing.port !== DEFAULT_DAEMON_PORT) {
    process.stderr.write(
      "[premiere-pro-full-mcp] fatal: bridge daemon endpoint not found. Run 'scripts/install-daemon.ps1' (or 'npm run build && node dist/daemon.js') to start the always-on bridge.\n",
    );
    process.exit(1);
  }

  try {
    const probe = await BridgeClient.connect(existing.port);
    await probe.close();
  } catch {
    process.stderr.write(
      "[premiere-pro-full-mcp] fatal: bridge daemon is not reachable at ws://127.0.0.1:" +
        DEFAULT_DAEMON_PORT +
        "/bridge. Start it with 'node dist/daemon.js' (installed as 'Premiere MCP Bridge Daemon').\n",
    );
    process.exit(1);
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
