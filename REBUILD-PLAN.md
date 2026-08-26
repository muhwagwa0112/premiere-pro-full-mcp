# PP_MCP Rebuild 1.0 — Local-First Minimal Architecture

Date: 2026-08-26

## Goal

전면 재작성. Local-only. No token auth, no manual approval, no planHash, no
preview/approve lifecycle. One persistent connection. All official 1.2.0 tools
(266 unique) exposed flat (no actionId) plus extras. Sequence automation
(open/edit) must work reliably. Remove all old artifacts.

## Definition of "efficient" (locked)

Efficiency = **fewest failure surfaces + lowest latency**, NOT implementation
ease. Every poll directory, leader lease, HMAC session, nonce, and signature
check is a failure surface. All removed.

## Architecture

```
MCP Server (stdio) ── spawn? no, same process ──┐
   │                                            │
   │ opens a WebSocket server on 127.0.0.1:<port>
   │ writes connection info to a single file:
   │   %LOCALAPPDATA%\PremiereMCP\bridge-endpoint.json
   │                                            │
   └── Premiere CEP extension reads that file once,
       connects back as a WebSocket client, keeps it open.

   Every tool call:
     server -> { requestId, op, args } over WS
     CEP -> evalScript into ExtendScript host.jsx
     host.jsx -> { ok, data } back over WS
```

No polling after startup. No leader. No auth. No nonce. Single channel (CEP).

## Tool surface

- Each official tool name becomes an MCP tool directly:
  `set_active_sequence`, `add_to_timeline`, ... (no `premiere_` prefix needed?
  keep `premiere_` prefix for clarity and collision safety with other MCP
  servers). Tools never take `actionId`.
- Input schema = that tool's own args only.
- Implementation = one `executeTool(name,args)` switch that builds the
  ExtendScript via helpers (`__findSequence`, `__findProjectItem`, ticks
  conversion, JSON compat) and sends over WS.

## What is deleted

Old docs, evidence, fixtures, generated catalogs, release staging, coverage,
validation results, native/UXP bridge, security layer, workflow/job engines,
collaboration/features registries that only served the auth/evidence model,
old tests, old cep main.js/host.jsx (replaced by thin WS host), old
package.json scripts.

## What survives (reused, not rewritten blind)

- `cep-plugin/json-compat.jsx` (ExtendScript JSON shim)
- `cep-plugin/host.jsx` semantics: we keep a **much smaller** host.jsx with
  only the operations we actually implement, dispatched on `operation`, with
  `JSON.stringify` compat preloaded.
- The public 266-name master list (`generated/official-tools-master.txt`) is
  regenerated from the installed official package at build time so the audit
  script never drifts.

## Deliverables

1. `src/bridge/ws-host.ts` — WS server + endpoint file
2. `src/tools/*` — flat tool table (266 + extras) + `executeTool`
3. `cep-plugin/host.ws.jsx` — tiny host, no poll/no auth
4. `cep-plugin/main.js` — reconnect loop + evalScript dispatch (no allowlist,
   no HMAC)
5. Tests: types, tool-name audit (>=266), E2E-ish bridge contract w/ mock
6. `npm run check` (typecheck + test + build) green

## Sequence automation (P0 contract)

`set_active_sequence(id|name)` -> host reads `app.project.sequences` by
`sequenceID`/`name`, sets `project.activeSequence`, returns its id/name.
`open_in_source` / `add_to_timeline` operate on that active sequence.
No silent fallback; unknown id -> truthful error.
