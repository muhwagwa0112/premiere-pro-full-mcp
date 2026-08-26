# Premiere Pro Full MCP (v1.0)

Local-first MCP server for Adobe Premiere Pro. Rebuilt from scratch:

- **No auth, no token, no approval dialogs, no plan-hash, no preview/confirm
  lifecycle.** This is a local tool; there is nothing to trust-gate.
- **One persistent connection.** The Node server opens a loopback WebSocket and
  the Premiere CEP extension connects back once. No file polling, no leader
  lease, no HMAC session, no nonce.
- **353 flat tools** (266 official `adobe-premiere-pro-mcp` v1.2.0 names +
  87 project-specific extras). Every tool is its own MCP tool named
  `premiere_<snake_case_tool>`. No `actionId` anywhere.
- **Sequence automation works**: `set_active_sequence`, `add_to_timeline`,
  `open_in_source`, `create_sequence`, `split_clip`, `trim_clip`, and friends
  are implemented in the ExtendScript host against the real Premiere PPRO DOM.

## Layout

```
src/                  TypeScript MCP server (thin)
  index.ts            stdio entry; connects to (or starts) the loopback WS bridge
  server.ts           registers 354 flat MCP tools (266 upstream + 87 extras +
                      capabilities) routed over one persistent bridge
  daemon.ts           always-on bridge daemon entry (auto-starts at logon)
  auto-start.ts       daemon auto-start wiring
  bridge/ws-host.ts   WS server + endpoint files (%LOCALAPPDATA%\PremiereMCP)
  bridge/ws-client.ts loopback WS client used by MCP servers
  bridge-types.ts     wire contract ({ kind, requestId, script } -> response)
  tool-names.ts       266 official + 87 extra tool names (single source of truth)
vendor/upstream/      official adobe-premiere-pro-mcp v1.2.0 handlers (validated)
cep-plugin/           Adobe CEP extension (Premiere side)
  main.ws.js          CEF client: reads endpoint, connects WS, evalScript to host
  CSInterface.js      CEP bridge shim
  index.html          minimal panel bootstrap
  CSXS/manifest.xml   extension manifest
scripts/
  smoke.mjs           assert >= 354 tools are advertised
  _e2e-bridge.mjs     daemon<->CEP wire-path exercise (mock host)
  _syntax-check.mjs   wrapped-script parse audit (no top-level return leak)
  _live-probe.mjs     ping the running daemon's CEP host
  install-daemon.ps1  register always-on daemon (Task Scheduler, logon)
  install-cep.ps1     deploy the CEP extension into Premiere's CEP folder
tests/                vitest: tool surface, server, bridge contract
```

## Build & verify

```bash
npm run build        # tsc (src -> dist)
npm run typecheck
npm test             # vitest (tool count, server 353+, bridge round-trip)
npm run check        # typecheck + test + build
node scripts/smoke.mjs   # assert >= 353 tools advertise
```

## MCP registration

Point your MCP client at this package's entry (or `npm start` equivalent) with
stdio transport. The server prints the loopback WebSocket port to stderr on
startup; the CEP extension reads `%LOCALAPPDATA%\PremiereMCP\bridge-endpoint.json`
to connect back.

## Tool surface

- Every tool is `premiere_<name>` and takes only that tool's arguments.
- `premiere_capabilities` returns the connected host + full tool list.
- Destructive-looking tools are still exposed flat (no approval gate); the
  ExtendScript host either performs the operation or returns a truthful error.

## License

MIT. The official `adobe-premiere-pro-mcp` (MIT) tool-name list is used as a
compatibility floor; implementations are original and local-first.
