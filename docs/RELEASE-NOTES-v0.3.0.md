# Premiere Pro Full MCP v0.3.0 release notes

v0.3.0 is the current Windows release of the capability-gated Premiere Pro 26.3 MCP runtime.

## Highlights

- Explicit `interactive`, `trusted_unattended`, and `isolated_lab` launch modes with locally enrolled,
  DPAPI-protected Trust Profiles.
- Route/session/effective-request-bound authorization, safe fallback only for `not_dispatched`, and
  persistent reconciliation quarantine for unknown outcomes.
- Protected durable `premiere_jobs` DAGs with bounded plans, cancellation boundaries, verified
  resume behavior, and evidence-gated rollback.
- Explicit verified project checkpoints and bounded semantic project, media, track, and clip actions.
- Fixed-fingerprint Windows UI semantic adapters; raw selectors and arbitrary UI calls are not public.
- Generated 51-action backend matrix and 150-entry feature registry covering editing,
  post-production, collaboration, service, third-party, and native boundaries.
- One implemented-unverified inspection/delivery workflow with durable checkpoint evidence before
  and after export. Other unavailable workflows remain plan-only or blocked.
- Automatic UXP connection to the fixed localhost bridge, with one-click manual retry and no user
  token, file picker, or pairing bootstrap. The existing capability/fingerprint handshake and
  operation authorization remain enforced.

## Validation

- 33 TypeScript test files / 197 tests passed.
- 36 Windows UI agent tests passed.
- Release security tests passed ZIP traversal, package-attribute, symlink/reparse, and detached
  signature-tamper rejection.
- Support/feature registry checks, 761-member UXP plan validation, disposable fixture planning, and
  MCP smoke passed.
- The installed v0.3 runtime passed CEP/QE, named-pipe UI transport, interactive project
  create/import/sequence/save, local UXP frame and sequence export, and 761-member live
  catalog validation on Premiere Pro 26.3.2. The live ledger retained the 281-success baseline and
  recorded 31 read-only calls as explicit fail-closed outcomes.

## Evidence boundary

The v0.3 interactive create/import/sequence/export/save paths now have disposable live-host evidence
documented in `LIVE-VALIDATION.md`. Unattended, durable-job, checkpoint, semantic relink/proxy/track/
clip, recoverable-overwrite, cloud/service, third-party, modal, and entitlement-dependent paths do
not inherit that evidence and retain their generated support states.

The CCX was packaged with Adobe UXP Developer Tool and the same package passed UDT developer loading
and installation through Adobe Unified Plugin Installer Agent 8.5.0.13. Premiere Pro 26.3.2 loaded
the installed v0.3.0 plug-in, and all six installed files matched the CCX byte-for-byte by SHA-256.
The floating packaged panel exposed every primary control at 340x326 outer / 324x287 client pixels
and 96 DPI, including an exact 320x260 nested UXP content view matching the manifest minimum. The
comparison is retained in `docs/evidence/ccx-install-layout-v0.3.0.json`. Docked and non-100% Windows-
scale observations remain required and are not represented as passed release gates.

## Assets

The public release set consists of the Windows ZIP, UDT-produced CCX, SPDX SBOM, third-party notices,
SHA-256 sidecars, and the RSA-signed release manifest/signature. The Windows ZIP contains the bundled
MCP runtime, self-contained native launcher, UXP/CEP bridges, generated registries, complete guides,
installer/update/doctor/uninstall tools, in-package SBOM/notices, and signed integrity manifests.
