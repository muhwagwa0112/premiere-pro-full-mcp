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
// instance of this MCP server is already listening there, this instance joins
// that leader as a relay and shares its live panel session instead of failing
// at boot. A leader that loses its panel session is replaced transparently the
// next time a follower connects.
await uxp.start();

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
