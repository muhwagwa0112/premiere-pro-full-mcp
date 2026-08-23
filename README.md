# Premiere Pro 2026 Local MCP

Local, capability-aware MCP control for the installed Adobe Premiere Pro 2026 host.
The project is a runtime-adaptive implementation targeting Windows and Premiere Pro 26.3.2.

## Safety and support contract

- Documented UXP is preferred. CEP/ExtendScript fills documented gaps, QE is experimental,
  and foreground Windows UI Automation is the last resort.
- A failed mutating request is never replayed through another backend automatically.
- R0 inspection and R1 undoable edits may execute directly. R2/R3 operations require a
  short-lived approval ID created by `premiere_operations` in `preview` mode and explicitly
  approved out-of-band in a local interactive terminal with `npm run approve -- <approval-id>`.
- Raw ExtendScript, arbitrary QE, selectors, clicks, shell commands, and credential extraction
  are not public MCP operations.
- `verified` means a postcondition was observed in a supported live host. Unit tests and mocks
  alone never establish live Premiere support.

## Development

Requirements: Node.js 20.19+ (Node 24 preferred), .NET 8 SDK, Premiere Pro 2026 26.3+,
and UXP Developer Tools.

```powershell
npm install
npm run inventory:adobe
npm run check
dotnet test .\windows-ui-agent\tests\PremiereMcp.WindowsUiAgent.Tests.csproj
npm run validate:uxp-full -- --ledger "$env:TEMP\ppmcp-uxp-full-surface-live.json"
```

Run the local MCP server with `npm start`. Set `PREMIERE_MCP_UXP_TOKEN` to a secret of at
least 24 characters before connecting the UXP panel. The listener binds to `127.0.0.1`; the
default port is `17777` and can be changed with `PREMIERE_MCP_UXP_PORT`.

CEP uses `%LOCALAPPDATA%\PremiereMCP\cep` unless `PREMIERE_MCP_CEP_DIR` is set. It accepts
typed operation envelopes only. Command, response, and heartbeat files are HMAC authenticated
through a caller-restricted .NET broker whose DPAPI CurrentUser-protected key is never exported;
they also include nonce, CEP-session, and freshness checks. The Windows UI agent uses the `PremiereMcpUi` named pipe and
requires a 24+ character `PREMIERE_MCP_UI_TOKEN`. The UI agent foundation exposes semantic
UI Automation primitives, but the MCP router rejects UI mutation until a versioned per-feature
adapter has been registered and live-verified.

The registered MCP starts through the installed native `--launch-mcp` broker. It pins the Node,
Premiere, and installed helper paths and SHA-256 values, clears Node preload variables, and runs a
single dependency-bundled MCP file whose exact directory contents and hash are verified before
launching. The runtime therefore does not load executable code from `node_modules`. After any
source, Node, or Premiere upgrade, rebuild and deliberately update the broker manifest before reinstalling.

Filesystem actions are fail-closed until `PREMIERE_MCP_APPROVED_ROOTS` contains one or more
semicolon-separated absolute roots. Existing paths and the nearest existing parent of new output
paths are canonicalized so Windows junction/reparse-point escapes are rejected.

## MCP surface

The server exposes capability discovery, inspection, operation lifecycle, and consolidated
domain tools for project, media, timeline, effects/audio, text/captions, export, workspace,
plugins, cloud workflows, and the `premiere_api` full-surface router. The generated Adobe 26.3
catalog contains 69 roots and 761 callable members (418 methods, 323 properties/constants, and
20 constructor/call signatures). Search it with `uxp.catalog`, then use the server-selected risk
operation (`uxp.read`, `uxp.edit`, `uxp.sensitive`, `uxp.filesystem`, or `uxp.destructive`).
Returned native objects use session-bound `$ref` handles; oversized results use explicit pages.
Transactions, locked read batches, callback-backed APIs, and event subscriptions have bridge-owned
adapters instead of accepting JavaScript functions.

Legacy ExtendScript and QE discovery returns opaque capability IDs from approved roots. It never
accepts a caller-provided object path or script. QE additionally inventories installed video effects
and transitions. `ui.catalog` enumerates bounded foreground controls that have a stable AutomationId
and a supported semantic pattern; `ui.invoke` accepts only an exact AutomationId, allowlisted control
type, and invoke/toggle/select action. Menu labels, coordinates, raw selectors, arbitrary CSXS events,
raw JSX, shell execution, and credential access are intentionally not representable.

Action-specific schemas and backend status are available from
the `premiere://capabilities` and `premiere://actions/{domain}` resources.

## Current verification boundary

Automated tests verify the 761-member declaration inventory, fail-closed risk classification,
schemas, authority, confirmation binding, routing, privacy-safe ledger records, and bridge protocol
behavior. The full-surface validator checks every catalog ID exactly once against the live catalog,
but live-executes only deterministic read-only entries. Declaration coverage is not a claim that every
member succeeds in every host state. CEP, QE, UI, third-party panels, entitlements, modal dialogs, and
cloud workflows are reported separately. Features which Adobe exposes only through an undocumented or
credential-bearing interface remain blocked rather than being simulated with raw code or clicks.

The v0.2.0 release candidate was exercised against installed Premiere Pro 26.3.2 using an isolated
project under `%LOCALAPPDATA%\PremiereMCP\workspace`. The authenticated UXP bridge advertised the
full 761-member catalog through a `ws://localhost`-only manifest permission; live checks covered R0
project/sequence/track handles, an approved R3 deferred-action transaction with exact name readback
and restoration, project save, and a verified 640x360 PNG frame export. CEP/QE checks covered host,
project, generated surface, installed effects, project create/open/import, sequence creation, and a
verified H.264/AAC sequence export. The native approval broker, bundle pinning, and fresh-process MCP
startup were also exercised. See `docs/LIVE-VALIDATION.md` for the evidence boundary.

After a final packaged reinstall and host restart, CEP/QE and UI-agent health reconnected automatically.
UXP workspace registration remains intact, but Adobe UXP Developer Tool still requires **Load** or
**Load & Watch** after a cold host restart. With the panel loaded in Premiere 26.3.2, the final live
full-surface run matched the generated fingerprint and found all 761 IDs. It attempted 312 deterministic
read-only calls: 281 succeeded and 31 failed closed (`METHOD_UNAVAILABLE` 18, `ROOT_UNAVAILABLE` 7,
`HANDLE_REQUIRED` 6). Another 151 mutation/filesystem/sensitive/destructive entries were preview-only
and not applied; 298 context-dependent entries were skipped with an explicit reason.

Windows UI Automation health is live-verified through a killable, single-concurrency worker with a hard
deadline. A foreground read-only catalog returned three semantic controls and an explicit truncated
result; it did not establish general UI mutation coverage. `ui.invoke` therefore remains fail-closed
outside registered per-feature adapters. A catalog entry is addressable, not proof that every
context-dependent Adobe call can succeed without the required project object, plug-in, entitlement,
media type, or foreground UI state.

Public release preparation and the required legal/signing decisions are tracked in
`docs/RELEASE-CHECKLIST.md`. This repository intentionally does not infer a project license from its
dependencies.
