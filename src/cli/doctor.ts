#!/usr/bin/env node
import { LocalAdapter } from "../bridge/local-adapter.js";
import { UxpWebSocketAdapter } from "../bridge/uxp-websocket.js";
import { CepFileAdapter } from "../bridge/cep-file.js";
import { UiNamedPipeAdapter } from "../bridge/ui-named-pipe.js";

const adapters = [new LocalAdapter(), new UxpWebSocketAdapter(), new CepFileAdapter("cep"), new CepFileAdapter("qe"), new UiNamedPipeAdapter()];
const results = await Promise.all(adapters.map(async (adapter) => ({ backend: adapter.backend, ...(await adapter.availability()) })));
process.stdout.write(`${JSON.stringify({ target: "Adobe Premiere Pro 2026 26.3.2", results, privacy: "No project names, paths, media names, prompts, or tokens were collected." }, null, 2)}\n`);
