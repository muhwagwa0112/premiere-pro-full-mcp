# Premiere Pro 26.3.2 live validation

Validated on Windows against installed Adobe Premiere Pro 26.3.2 with an isolated project, generated
test media, preset, and outputs under `%LOCALAPPDATA%\PremiereMCP\workspace\live-validation`.
No real user project or media was used.

## Verified live paths

- UXP authenticated over a manifest-constrained `ws://localhost/` permission and reported host
  version 26.3.2. The generated catalog returned 761 members, 91 containers, and 69 roots.
- The installed CCX registers the `premiereMcp2026Panel` lifecycle through `entrypoints.setup`, so
  Premiere creates the packaged panel document instead of an empty menu-discovered surface.
- R0 UXP calls resolved active Project, Sequence, and VideoTrack session handles and read the original
  track name.
- An R3 `uxp.transaction.execute` request was previewed, approved in the native Windows dialog,
  committed under Premiere 26.3 `lockedAccess`, read back with the changed name, then separately
  approved and restored to its original name. This caught and fixed the Premiere 26.3 Action-lifetime
  breaking change.
- `export.frame` wrote a 68,832-byte 640x360 RGBA PNG. The bridge re-opened the exact output and
  reported `verified`; SHA-256 was
  `3ff1945dccec98b746df00b1a874e60faf67b723ee9dc86b707ee005c25741c4`.
- `project.save` returned true and retained the active project.
- CEP/QE live checks covered host/project inspection, reflected surface catalog, effect inventory,
  project create/open/import, and sequence creation. The UXP `EncoderManager.exportSequence` path
  dispatched the export without treating its host Promise as completion, then independently verified
  a changed, non-empty, stable output file. The result was a 3-second 1280x720 H.264/AAC MP4,
  2,837,041 bytes, SHA-256
  `910c5b0527eb00715048614d108f05934fe0e92d45c1808e870363562ff53712`.
- The installed native launcher, bundle integrity pin, DPAPI-backed signing broker, one-shot approval
  dialog, MCP tool discovery, and secret-preload scrubbing passed local smoke checks.
- A final full-surface ledger matched the generated and live UXP fingerprints and checked catalog
  presence for 761/761 unique IDs. Of 312 deterministic read-only calls attempted against Premiere
  26.3.2, 281 succeeded and 31 failed closed: 18 `UXP_METHOD_UNAVAILABLE`, 7
  `UXP_ROOT_UNAVAILABLE`, and 6 `UXP_HANDLE_REQUIRED`. The validator recorded only stable result
  shapes and error codes, never return values, messages, paths, or secrets.
- The remaining 449 entries were still accounted for individually: 151 mutation, filesystem,
  sensitive, or destructive entries were preview-only and not applied; 298 entries requiring typed
  handles, arguments, callbacks, or transaction context were skipped with explicit reasons.

## Automated gates

- TypeScript/bridge check: 14 test files, 45 tests, including concurrent one-shot approval claiming,
  the full-surface safety-plan contract, sequence-export single-flight/stable-output verification,
  existing-output rejection, and the UDT-only release packaging contract.
- Native .NET check: 19 tests, including job-object child cleanup, strict UTF-8 HMAC input, and
  hostile broker-locator/preload environment scrubbing.
- MCP smoke: 13 tools, 761 Adobe UXP members, 139 local plug-ins.
- Security smoke: broker signing succeeded; MCP self-approval remained blocked; preload variables were
  scrubbed.
- MCP and security smokes use process-specific UI pipes. The security smoke waits for the live UXP
  backend on port 17777 by default so its self-approval rejection assertion cannot pass or fail before
  a real backend is selectable; the port can be overridden for an explicitly reconfigured panel.
- A fresh `codex exec` process called the installed registration and reported target 26.3.2, 761 UXP
  declarations, backend `uxp`, host 26.3.2, and `uxp_available=true` with the panel loaded.
- A foreground UI catalog completed within its hard deadline and returned three controls with
  `complete=false` and `truncated=true`; UI mutation remains outside the verified surface.

## Explicit boundary

The declaration inventory is full-surface routing coverage, not 761 successful live executions.
Many Adobe members require object types, installed third-party plug-ins, cloud entitlements, media,
or project states that cannot all coexist in one fixture. CEP and UXP developer loading can also be
affected by host modal/busy state during a cold restart and must be checked after installation.

After the final packaged reinstall and host restart, CEP/QE and the named-pipe UI health check
reconnected automatically. UXP workspace registration was preserved, but Adobe UXP Developer Tool
still requires **Load** or **Load & Watch** after a cold restart. The panel was loaded for the final
full-surface run described above, so the latest UXP evidence is from the current bridge rather than an
earlier bundle.

Premiere's native UI Automation provider previously blocked during descendant enumeration on this
machine. The final build isolates every UIA request in a killable, single-concurrency worker with a hard
deadline. A foreground catalog now completes and exposes a small, truncated set of semantic controls,
but that is insufficient to claim broad UI coverage. UI mutation remains fail-closed until a versioned
adapter selects a unique pattern-backed control and verifies the requested postcondition.
