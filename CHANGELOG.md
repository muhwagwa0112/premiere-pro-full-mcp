# Changelog

All notable changes to this project are documented here.

## 0.4.0 - 2026-08-25

- Removed the approval/cancel dialog from the normal path: high-level instructions compile to a
  linear step sequence (`premiere_flows`) and each step commits as its own observable transaction
  with its own undo unit; safety is automatic checkpoints plus automatic undo.
- Added a step event bus so clients can relay live progress while the user watches the editor.
- Live-validated against a real Premiere Pro 26.3.2 host on Windows: a real project was opened, its
  project/sequence/caption snapshots were read over the UXP bridge, a verified pre-mutation
  checkpoint whose SHA-256 matched the saved project was created, and the live project was written
  to disk through `project.save`. Updated README with the live-run evidence and the UXP-vs-CEP
  notes for `sequence.inspect`.
- Fixed the single-UXP-listener problem: multiple MCP instances now share the leader's panel session
  as authenticated relays, with follower-to-leader promotion and a keep-alive retry when an
  incompatible owner holds the port.
- Registered Premiere Pro Full MCP as a Codex connector and unified the plugin-marketplace MCP server
  name with the installer registration so fresh threads discover the same tools as the Doctor path.
- Kept the truthful capability surface: features that cannot be driven by local scripting remain
  explicitly blocked/manual instead of being registered but non-functional.
- Added a signed v0.4.0 Windows release package with the bundled runtime, launcher, bridges,
  registries, guides, SBOM, notices, and signed integrity manifests.

## 0.3.0 - 2026-08-24

- Added explicit `interactive`, `trusted_unattended`, and `isolated_lab` install/launch modes with SID/product/launcher-bound, DPAPI-protected Trust Profiles.
- Bound authorization to canonical execution-plan hashes, process-scoped leases, exact backend session identity, and effective bridge arguments.
- Added capability-aware per-operation routing with fallback only for explicit `not_dispatched` outcomes.
- Added verified pre-mutation checkpoints, durable reconciliation quarantine, and recoverable sequence-overwrite transactions.
- Added a durable, protected `premiere_jobs` engine with bounded DAG plans, cancellation boundaries,
  resume/rollback evidence requirements, restart reconciliation, and cross-process quota locking.
- Added bounded semantic actions for explicit checkpoints, disposable-project close, Save As, relink,
  proxy attachment, track mute, and clip insertion with exact post-dispatch verification.
- Added fixed-version/fingerprint Windows UI semantic adapters and removed raw public UI invocation.
- Added a deterministic 51-action × 5-backend support matrix and a 150-entry feature registry across
  editing, post-production, collaboration, third-party, and native-extension domains.
- Added the `post.inspect_delivery` durable workflow with verified checkpoint evidence before and
  after export; all other unavailable workflows and entitlement-dependent operations remain
  truthfully plan-only, unsupported, or blocked.
- Added connector/native contract boundaries, disposable fixture planning, generated feature docs,
  and release-package coverage for the new registries and guides.
- Preserved the existing exact-plan interactive R2/R3 approval flow while making per-operation approval unreachable in enrolled unattended modes.

## 0.2.0 - 2026-08-23

- Added adaptive routing for the generated Adobe Premiere Pro 26.3 UXP surface: 761 members across 91 containers and 69 roots.
- Added authenticated local UXP, typed CEP/ExtendScript, experimental QE, and bounded Windows UI Automation backends.
- Added native one-shot approval, DPAPI-backed signing, bundle integrity pinning, filesystem root confinement, and fail-closed mutation routing.
- Added a full-surface validation ledger. It checks all 761 catalog entries exactly once and live-executes only the deterministic read-only subset.
- Added reproducible Windows release packaging, manifest hashing, SBOM generation, and third-party notices.
