#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { OperationEngine } from "./operation-engine.js";
import { LocalAdapter } from "./bridge/local-adapter.js";
import { UxpWebSocketAdapter } from "./bridge/uxp-websocket.js";
import { CepFileAdapter } from "./bridge/cep-file.js";
import { UiNamedPipeAdapter } from "./bridge/ui-named-pipe.js";
import type { BackendAdapter } from "./contracts.js";

const uxp = new UxpWebSocketAdapter();
await uxp.start();

const adapters: BackendAdapter[] = [
  new LocalAdapter(),
  uxp,
  new CepFileAdapter("cep"),
  new CepFileAdapter("qe"),
  new UiNamedPipeAdapter(),
];
const engine = new OperationEngine(adapters);
const server = createServer(engine);
const transport = new StdioServerTransport();

const shutdown = async () => {
  await Promise.all(adapters.map(async (adapter) => adapter.close?.()));
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

await server.connect(transport);
