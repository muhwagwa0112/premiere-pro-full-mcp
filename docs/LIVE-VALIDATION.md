# Premiere Pro 26.3.2 live validation

Validated on Windows against the installed v0.3.0 runtime and Adobe Premiere Pro 26.3.2 on
2026-08-24. The fixture used generated media, a dedicated preset, and a dedicated project under
`%LOCALAPPDATA%\PremiereMCP\workspace\v0.3-release-20260824`. The project was saved through MCP,
read back, and then manually closed with Premiere's Close Project shortcut. No user project or user
media was used.

## v0.3 release gates

- `npm run check` covers bridge syntax, TypeScript, 33 Vitest files / 201 tests, and the bundle build.
- The native Windows agent has 36 tests. The generated support matrix contains 51 public actions and
  the broader feature registry contains 150 records.
- The plan and live UXP ledgers account for all 761 generated members. The live catalog fingerprint
  matched the generated inventory on Premiere 26.3.2.
- Release-security validation covers ZIP traversal, package attributes, reparse/symlink input, case
  collisions, signature tampering, unexpected package files, signed downgrade, and forced
  partial-install rollback.
- The CEP payload is signed during a clean release build. Adobe `ZXPSignCmd 4.1.103 -verify` accepted
  both the packaged and installed CEP directories, and CEP/QE reconnected with `PlayerDebugMode=0`.

## Verified installed-runtime paths

- The installed native launcher, pinned bundle, DPAPI-backed broker, one-shot approval dialog, MCP
  discovery, and secret-preload scrubbing passed local checks.
- CEP/QE host, project, sequence, bounded `app` reflection, and bounded `qe` reflection succeeded on
  host version 26.3.2. The named-pipe UI catalog request completed without timeout; it exposed zero
  registered semantic controls in this host state, so it proves transport fail-closed behavior and
  does not establish broad UI automation coverage.
- The exact v0.3 UXP source was packaged with Adobe UXP Developer Tool and installed by Adobe UPIA.
  Opening the installed panel established its automatic protocol-v3 mutually authenticated connection
  over the exact `file://` Origin allowlist and reported 761 members,
  91 containers, 69 roots, and fingerprint
  `3ad423e187ccb155afd139a8181bdc3093de357fb183d7505b4a00e1e3c3b17e`.
- Interactive exact-plan approvals retained the same `operationId`, `planHash`, route, session, and
  effective request from preview through apply. Project creation, media import, and sequence creation
  succeeded through the typed CEP path. Frame export, sequence export, and project save succeeded
  through the local UXP bridge. Premiere readback confirmed project GUID
  `2d5a8727-5613-4592-8537-3291d5f3c720` and sequence GUID
  `ae351990-ac38-40ab-8649-df0836253613`.
- The saved project was 12,386 bytes with SHA-256
  `091cc9da254f0e386fa88bee20b9361086e9cce7ca77be4cb8045d770a95ac1d`.
- `export.frame` produced a 68,832-byte 640x360 PNG with SHA-256
  `3ff1945dccec98b746df00b1a874e60faf67b723ee9dc86b707ee005c25741c4`.
- `export.sequence` produced a stable 2,837,041-byte MP4 with SHA-256
  `e27a96b9a66f1997b721d437d1373b22c7e8d892fa0fe16689d72a9df6216ae3`.
- The final full-surface live ledger contains 761/761 unique IDs. Of 312 deterministic read-only
  calls, 281 succeeded and 31 failed closed. Another 151 mutation/filesystem/sensitive/destructive
  entries were preview-only and not applied; 298 entries requiring typed handles, arguments,
  callbacks, or transaction context were skipped with explicit reasons.

The retained machine-readable evidence is
`docs/evidence/uxp-full-surface-ledger-v0.3.0.json`. It records stable result shapes and error
codes only; it does not record returned values, messages, absolute paths, or secrets.

## Explicit release boundary

The UDT-produced v0.3.0 CCX passed manifest/identity validation and UDT developer loading. After the
stale v0.2.0 installation was removed, Adobe Unified Plugin Installer Agent 8.5.0.13 installed the
same CCX successfully and listed `Premiere Pro Full MCP Bridge` v0.3.0 as enabled for Premiere Pro
26.3.2. All seven installed files matched the CCX entries byte-for-byte by SHA-256. Adobe UDT IPC
the Premiere **Window > UXP Plugins** menu opened that exact installed plug-in. Premiere's
accessibility tree exposed the UXP panel, its Connect retry button, and the named panel tab. The MCP
capability response reported `uxp.available: true`, host version 26.3.2, a live session ID, and the
exact generated catalog fingerprint without user token entry or pairing UI. A legacy protocol-v2
client was rejected with WebSocket close code 1008 and did not replace or disconnect the authenticated
panel session. At 100% Windows scale, the floating
window measured 340x326 outer / 324x287 client pixels at 96 DPI. At 125% Windows scale, Premiere
reported 120 DPI and the same installed panel measured 338x324 outer pixels with an exact 320x260
nested UXP content view. The Connect retry control and named panel tab remained present at both
scales. The retained file-hash and window-geometry record is
`docs/evidence/ccx-install-layout-v0.3.0.json`. At 125% scale, the same installed panel was then
docked into Premiere's main workspace. The accessibility hierarchy placed `dvauxpuiUXPPanel` and
its Connect retry button under the main `WorkspaceFrame` / `TabPanelContainer`, alongside the named
`Premiere Pro Full MCP` tab, with no separate floating panel window. The complete
minimum/docked/floating/scaled layout gate therefore passed.

The live fixture above verifies only the listed interactive create/import/sequence/export/save paths.
It does not promote trusted-unattended enrollment, durable jobs, checkpoint workflows, disposable
semantic close, relink/proxy/track/clip semantic mutations, recoverable overwrite, cloud/service,
third-party, modal, or entitlement-dependent paths. Those retain the contextual, unverified,
plan-only, blocked, or unsupported states recorded in the generated matrices.

Inventory coverage is not universal execution coverage. A timeout, unavailable host object, missing
semantic control, external installer failure, or unverified postcondition is never counted as success.
