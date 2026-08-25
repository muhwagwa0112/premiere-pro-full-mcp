#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { OperationEngine } from "./operation-engine.js";
import { FlowRunner } from "./flows/flow-runner.js";
import { LocalAdapter } from "./bridge/local-adapter.js";
import { UxpWebSocketAdapter } from "./bridge/uxp-websocket.js";
import { CepFileAdapter } from "./bridge/cep-file.js";
import { UiNamedPipeAdapter } from "./bridge/ui-named-pipe.js";
import type { BackendAdapter } from "./contracts.js";
import { AuthorizationService } from "./security/authorization-service.js";
import { SessionLease } from "./security/session-lease.js";
import { PathPolicy } from "./security/path-policy.js";

const uxp = new UxpWebSocketAdapter();
// The UXP panel bridge binds a single local port (default 17777). When another
// instance of this MCP server is already listening there (for example a second
// Codex thread or CLI), starting would fail with EADDRINUSE and kill this
// instance before any tool is registered. The panel can only connect to one
// bridge at a time, so the portable behaviour is: keep this instance alive and
// truthfully report the UXP backend as unavailable rather than dying at boot.
try {
  await uxp.start();
} catch (error) {
  const causeMessage = error instanceof Error ? error.message : String(error);
  const eaddrinuse = causeMessage.includes("EADDRINUSE") || causeMessage.includes("address already in use");
  if (eaddrinuse) {
    process.stderr.write(`[premiere-mcp] UXP bridge port is already owned by another instance; continuing with the local UXP backend unavailable (${causeMessage}).\n`);
  } else {
    throw error;
  }
}

const adapters: BackendAdapter[] = [
  new LocalAdapter(),
  uxp,
  new CepFileAdapter("cep"),
  new CepFileAdapter("qe"),
  new UiNamedPipeAdapter(),
];
// Lease creation is deliberately part of startup: an invalid launcher chain,
// missing trust profile, or mode/profile mismatch must terminate rather than
// silently falling back to interactive authorization.
const lease = await SessionLease.createForCurrentProcess();
const authorizationService = await AuthorizationService.createFromEnvironment({ lease });
const trustedRoots = authorizationService.approvedRoots();
const engine = new OperationEngine(adapters, { authorizationService, ...(trustedRoots ? { pathPolicy: new PathPolicy([...trustedRoots]) } : {}) });
const flows = new FlowRunner(engine, { authorizationService });
const server = createServer(engine, undefined, flows);
const transport = new StdioServerTransport();

const shutdown = async () => {
  await Promise.all(adapters.map(async (adapter) => adapter.close?.()));
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

await server.connect(transport);
