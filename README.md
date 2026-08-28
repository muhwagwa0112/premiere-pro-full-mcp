# Premiere Pro Full MCP (v2.0)

Local-first MCP server for Adobe Premiere Pro. Rebuilt from scratch to be a safe,
local-only tool.

## Highlights

- **No external account or API token.** CEP is loopback-local and UXP uses a
  machine-local HMAC key. There is no remote auth, approval envelope,
  `actionId`, plan-hash, or preview/confirm lifecycle.
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
- **Host failures fail closed.** Request timeouts are carried end to end, CEP
  disconnect/replacement settles pending work immediately, and timed-out
  mutations are recorded as `UNKNOWN` rather than treated as safe retries.
  The daemon serializes CEP work, holds one mutation lease across mixed
  CEP/UXP subrequests, and quarantines later mutations until recovery is
  explicitly acknowledged against the observed project fingerprint. When the
  coordinator is enabled, untagged CEP/UXP mutation requests are rejected.
- **Large raw scripts are bounded.** `premiere_execute_extendscript` accepts a
  real timeout up to 120 seconds, but is limited to 16 KiB and one risky
  operation class. Placement, keyframe, and project-save APIs cannot be mixed
  in one raw script; use their dedicated MCP tools as separate stages.

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
  operations/         daemon ledger, tool policy, queues, recovery coordinator
  tool-names.ts       266 official + 87 extra tool names (single source of truth)
vendor/upstream/      official adobe-premiere-pro-mcp v1.2.0 handlers (validated)
cep-plugin/           Adobe CEP extension (Premiere side, fallback track)
  main.ws.js          CEF client: reads endpoint, connects WS, evalScript to host
  CSInterface.js      CEP bridge shim
  index.html          minimal panel bootstrap
  CSXS/manifest.xml   extension manifest
uxp-plugin/           Adobe UXP plugin (Premiere side, primary edit/export track)
  manifest.json       UXP manifest (id com.codex.premiere-pro-full-mcp, v2.0.0)
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
npm run verify:release   # version/manifest coherence before staging a release
```

## Release staging

Do not reuse an old ZIP or tarball after changing the CEP bridge. Stage a new
release only after the source checks pass, then verify every archive against
the current source before publishing:

```powershell
node scripts/build-release.mjs --out .release-staging
node scripts/verify-release.mjs .release-staging\premiere-pro-full-mcp-2.0.0.tgz
```

The staging command refuses a non-empty output directory and a dirty worktree.
It runs the acceptance gate, then emits and verifies the npm tarball, Windows
ZIP, UXP CCX, per-artifact SHA-256 files, and `release-manifest.json`. For a
local non-publishable verification build, add `--allow-dirty`.

## CEP upgrade and legacy-conflict guard

Close Premiere Pro before upgrading the CEP bridge and daemon. The CEP `ready`
handshake is protocol-versioned and identity-checked, so the CEP files and
daemon must use a compatible bridge protocol. Installing both from the same
release is the supported upgrade path; install them together, then reopen
Premiere:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-all.ps1 -RestartDaemon
```

The installer audits each immediate child of `%APPDATA%\Adobe\CEP\extensions`
by its `CSXS\manifest.xml` bundle ID. If the obsolete
`com.local.ppmcp.cep.2026` bundle is present, installation fails closed with
`CEP_LEGACY_CONFLICT`; similarly named folders and unrelated extensions are not
changed. To migrate that exact legacy bundle, opt in to reversible quarantine:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-all.ps1 `
  -RestartDaemon -QuarantineKnownLegacyCep
```

The legacy folder is moved outside CEP discovery under
`%LOCALAPPDATA%\PremiereMCP\quarantine\cep\<timestamp-id>\`. Its original path,
bundle ID, manifest SHA-256, quarantine time, and restore location are recorded
in `quarantine.json`; it is not permanently deleted by the installer. Restarting
Premiere after the move is required because terminating or moving a loaded CEP
folder does not unload that runtime from the current Premiere process.

## UXP plugin install (.ccx)

The UXP bridge is what lets the MCP server reach the Premiere 26.x APIs that
CEP/ExtendScript cannot. It ships both as an unpacked plugin folder and as a
single `.ccx` package:

```bash
node scripts/build-ccx.mjs      # -> dist/premiere-pro-full-mcp-2.0.0.ccx
powershell scripts/install-uxp.ps1
```

`install-uxp.ps1` copies `uxp-plugin/` into
`%APPDATA%\Adobe\UXP\Plugins\External\com.codex.premiere-pro-full-mcp_<version>\`
(which Premiere auto-discovers) and seeds the shared HMAC key +
`bridge-settings-v1.json` into the plugin data folder so the panel authenticates
and finds the daemon immediately. Some Premiere/UXP builds gate the External
loader behind Adobe UXP Developer mode; the installer enables that flag when
the Developer settings path is present unless `-NoDevMode` is supplied. A CCX
installed through Adobe's trusted loader does not need that development flag.
`install-all.ps1` runs daemon + CEP + UXP in one shot.

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
  `uxpOperations`, `uxpCatalogCounts`, operation protocol versions, and
  recovery status.
- `premiere_connection_status` reports daemon/CEP/UXP session state, queues,
  quarantine, and unresolved operations. `premiere_health_check` performs a
  short callback/transport probe by default, performs an actual read-only
  `app.project` probe with `mode: "dom_readiness"`, or acknowledges one recovery
  item with its current fingerprint. The default `responsive: true` proves only
  that the CEP `evalScript` callback returned; it is deliberately separate from
  `transportResponsive` and `domReady` in the DOM-readiness result. Before
  resuming mutations after a host error, require three DOM-readiness successes
  in the same session/generation (`operationStatus.domReadiness.consecutiveSuccesses
  >= 3`). Premiere exposes no reliable generic modal-state API, so
  `modalState` remains `unknown`. Each mutation still requires its own 5-second
  target snapshot preflight; a blocked UI or DOM failure prevents dispatch.
- Read-only operations never use mutation postflight snapshots and terminate as
  `FAILED`, not `UNKNOWN`, even when the transport retains
  `outcomeUnknown: true` as a diagnostic. Mutation `UNKNOWN`, quarantine, and
  recovery semantics remain unchanged.
- Tools remain flat and need no approval dialog, but mutating calls receive a
  bounded operation ID, pre/post project fingerprint, script hash, target
  sequence hint, and terminal status in
  `%LOCALAPPDATA%\PremiereMCP\operations\operation-ledger-v1.jsonl`. Script,
  argument, and result bodies are not persisted.
- Recovery fingerprints use a bounded projection: up to 128 project sequences,
  512 project items, 32 tracks per media type, and 256 target-sequence clips.
  Effect/keyframe/raw-script operations also inspect components and up to 256
  properties across 16 clips. Time-varying properties are sampled at clip
  start/mid/end without materializing unbounded key arrays. Sequence settings
  use a fixed field projection. `BOUNDED_MATCH`
  means only that this projection matches the preflight snapshot; truncation
  metadata remains part of the fingerprint and it is not a full-project proof.
  Fingerprints from a different projection version are reported as
  `INCOMPARABLE_PROJECTION`, never as a project change or match.

Premiere does not expose a rollback transaction across multiple host calls.
Treat a CUT edit as a staged workflow: inspect/checkpoint, bounded placement,
verify, `save_project`, bounded keyframes, verify, and `save_project` again.
Stop after any failure or `UNKNOWN`; never replay a timed-out mutation
automatically.

## License

MIT. The official `adobe-premiere-pro-mcp` (MIT) tool-name list is used as a
compatibility floor; implementations are original and local-first.
