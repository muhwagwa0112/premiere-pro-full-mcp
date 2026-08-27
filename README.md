# Premiere Pro Full MCP (v1.2)

Local-first MCP server for Adobe Premiere Pro. Rebuilt from scratch to be a safe,
local-only tool.

## Highlights

- **No auth, no token, no approval dialogs, no plan-hash, no preview/confirm
  lifecycle.** This is a local tool; there is nothing to trust-gate.
- **One persistent dual-track connection.** The Node server opens a loopback
  WebSocket to the CEP extension (the classic ExtendScript host) AND a
  HMAC-authenticated UXP bridge. Tools that Premiere 26.x only exposes through
  UXP (`export_frame` / `capture_frame` via `Exporter`, the `SequenceEditor`
  transaction actions, clip move/remove/trim, effect add/remove, video
  transitions, track mute) automatically route over the UXP track; everything
  else runs over CEP/ExtendScript. No file polling, no leader lease.
- **354 flat tools** (266 official `adobe-premiere-pro-mcp` v1.2.0 names +
  87 project-specific extras + `premiere_capabilities`). Every tool is its own
  MCP tool named `premiere_<snake_case_tool>`. No `actionId` anywhere.
- **UXP-only operations actually work.** The previously-missing capabilities —
  frame capture, video transition add, clip effect add/remove, clip
  move/remove/trim, track mute — are implemented on the UXP panel bridge. The
  server reports `uxpConnected`, `uxpOperations`, and `uxpCatalogCounts` so an
  agent can see which track is live before mutating.
- **Frame capture is fixed.** Premiere 26.x CEP has no `exportFramePNG`; the
  `export_frame` / `capture_frame` tools now use the UXP `Exporter` path, so
  they produce a real, distinct frame at the requested playhead position.

## Layout

```
src/                  TypeScript MCP server (thin)
  index.ts            stdio entry; connects to the always-on bridge daemon
  server.ts           registers 354 flat MCP tools routed over one persistent bridge
  daemon.ts           always-on bridge daemon entry (auto-starts at logon)
  auto-start.ts       daemon auto-start wiring
  bridge/ws-host.ts   WS server + endpoint files (%LOCALAPPDATA%\PremiereMCP)
  bridge/ws-client.ts loopback WS client used by MCP servers
  bridge/uxp-host.ts  UXP bridge (HMAC /uxp WebSocket) for UXP-only operations
  bridge-types.ts     wire contract ({ kind, requestId, script } -> response)
  tool-names.ts       266 official + 87 extra tool names (single source of truth)
vendor/upstream/      official adobe-premiere-pro-mcp v1.2.0 handlers (validated)
cep-plugin/           Adobe CEP extension (Premiere side, fallback track)
  main.ws.js          CEF client: reads endpoint, connects WS, evalScript to host
  CSInterface.js      CEP bridge shim
  index.html          minimal panel bootstrap
  CSXS/manifest.xml   extension manifest
uxp-plugin/           Adobe UXP plugin (Premiere side, primary edit/export track)
  manifest.json       UXP manifest (id com.codex.premiere-pro-full-mcp, v1.2.0)
  main.cjs            WebSocket client + UXP-only ops
  main.js             panel bootstrap; auto-connects on create/show
  auth.cjs            HMAC handshake helpers (shared with daemon)
  api-catalog.cjs     generated Adobe UXP member allowlist (761 members)
  icons/icon.svg      panel icon
scripts/
  smoke.mjs           assert >= 354 tools are advertised
  _e2e-bridge.mjs     daemon<->CEP wire-path exercise (mock host)
  _live-probe.mjs     ping the running daemon's CEP host and UXP bridge
  _syntax-check.mjs   wrapped-script parse audit (no top-level return leak)
  build-ccx.mjs       package uxp-plugin/ into a .ccx (ZIP with manifest at root)
  install-daemon.ps1  register always-on daemon (Task Scheduler, logon)
  install-cep.ps1     deploy the CEP extension into Premiere's CEP folder
  install-uxp.ps1     deploy the UXP plugin into Premiere's UXP folder (no dev tool)
tests/                vitest: tool surface, server, bridge contract
```

## Build & verify

```bash
npm run build        # tsc (src -> dist)
npm run typecheck
npm test             # vitest (tool count, server 353+, bridge round-trip)
npm run check        # typecheck + test + build + smoke + e2e + syntax
node scripts/smoke.mjs   # assert >= 354 tools advertise
```

## UXP plugin install (.ccx)

The UXP bridge is what lets the MCP server reach the Premiere 26.x APIs that
CEP/ExtendScript cannot. It ships both as an unpacked plugin folder and as a
single `.ccx` package:

```bash
node scripts/build-ccx.mjs      # -> dist/premiere-pro-full-mcp-1.2.0.ccx
powershell scripts/install-uxp.ps1
```

`install-uxp.ps1` copies `uxp-plugin/` into
`%APPDATA%\Adobe\UXP\Plugins\External\com.codex.premiere-pro-full-mcp_<version>\`
(which Premiere auto-discovers) and seeds the shared HMAC key +
`bridge-settings-v1.json` into the plugin data folder so the panel authenticates
and finds the daemon immediately. Pass `-NoDevMode` to skip the UXP Developer
"developer" flag (needed only if Adobe's External loader is gated; normally the
external path loads without it). `install-all.ps1` now runs daemon + CEP + UXP in
one shot.

The panel opens via `Window > Extensions > Premiere Pro Full MCP`. It connects on
load and reconnects automatically on daemon restart or panel re-show (the bridge
module is idempotent and never tears down the socket on hide/destroy).

## MCP registration

Point your MCP client at this package's entry (`dist/index.js`) with stdio
transport. The server prints the loopback WebSocket port to stderr on startup;
the CEP extension reads `%LOCALAPPDATA%\PremiereMCP\bridge-endpoint.json` to
connect back. The UXP panel reads the bridge port from its plugin data folder.

## Tool surface

- Every tool is `premiere_<name>` and takes only that tool's arguments.
- `premiere_capabilities` returns the connected host, `uxpConnected`,
  `uxpOperations`, `uxpCatalogCounts`, and the full tool list.
- Destructive-looking tools are still exposed flat (no approval gate); the host
  either performs the operation or returns a truthful error.

## License

MIT. The official `adobe-premiere-pro-mcp` (MIT) tool-name list is used as a
compatibility floor; implementations are original and local-first.
