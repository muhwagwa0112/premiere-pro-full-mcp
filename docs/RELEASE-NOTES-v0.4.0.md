# Premiere Pro Full MCP v0.4.0 release notes

v0.4.0 is the current Windows release of the capability-gated Premiere Pro 26.3 MCP runtime.

## Highlights

- **Watch & Run execution model.** High-level instructions compile into a linear step sequence
  (`premiere_flows`) instead of opaque batch scripts. Each step commits as its own visible
  transaction with its own undo unit, and a step event bus lets the client relay live progress
  ("inserted at 00:04:12") while the user watches the editor. No approval/cancel dialog appears on
  the normal path.
- **Shared UXP bridge (leader relay).** Multiple MCP instances now co-exist on the single local UXP
  port instead of dying or degrading to a dead backend. The first instance binds the port as the
  leader; every later instance authenticates with the shared on-disk secret and relays commands
  through the leader's live panel session. A leader that disappears is replaced transparently by a
  follower promotion because the panel reconnects every two seconds.
- **Truthful capability surface.** The action catalog is aligned with what each backend can actually
  do. Cloud/entitlement/transcript/third-party paths that cannot be driven by local scripting are
  explicitly `BLOCKED`, `ENTITLEMENT_BLOCKED`, `EXTERNAL_SERVICE_REQUIRED`, or `MANUAL_ONLY` rather
  than being registered but silently non-functional.
- Typed CEP/ExtendScript, QE, and UXP handlers for project, media, timeline, track, clip, effects,
  audio, markers, in/out, playhead, proxy, relink, captions, and export operations.
- Automatic checkpoints plus automatic undo replace interactive safety: the user observes the editor
  changing and can always undo the last visible step, while irreversible risks (such as overwriting
  an existing export) are blocked in code without a dialog.

## UXP bridge sharing

The single UXP listener problem that caused "tools not recognized in another instance" is fixed at
the bridge layer:

- Follower instances complete a full challenge/connect handshake with the same local key, then
  register as relays. They forward peer commands to the leader's panel and receive responses only
  for their own requests.
- `peer-update` broadcasts keep follower capability and session metadata in sync; a panel disconnect
  fails only the affected in-flight relays.
- A follower whose leader closes promotes itself to leader so the panel reconnects (2 s retry) and
  the remaining instances keep working.
- If the port is owned by an incompatible process, the instance stays alive, keeps serving local
  backends, and retries ownership instead of exiting.

## Validation

- `npm run check` passes: lint, typecheck, 34 test files / 212 tests, and the bundle build.
- New bridge tests cover leader/follower relay sharing, a follower with no panel session, and
  follower-to-leader promotion.
- A live two-instance relay check was run against Premiere Pro 2026 on this machine: the first
  instance owned port 17777, the second instance relay-connected to it, and both instances exposed
  all MCP tools and answered `premiere_inspect` successfully.

## Assets

The public release set consists of the Windows ZIP, the UDT-produced CCX, the SPDX SBOM, third-party
notices, SHA-256 sidecars, and the RSA-signed release manifest/signature. The Windows ZIP contains
the bundled MCP runtime, the self-contained native launcher, UXP/CEP bridges, generated registries,
complete guides, installer/update/doctor/uninstall tools, in-package SBOM/notices, and signed
integrity manifests.
