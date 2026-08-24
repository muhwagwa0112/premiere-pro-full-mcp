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

## Validation

- 33 TypeScript test files / 190 tests passed.
- 37 Windows UI agent tests passed.
- Release security tests passed ZIP traversal, package-attribute, symlink/reparse, and detached
  signature-tamper rejection.
- Support/feature registry checks, 761-member UXP plan validation, disposable fixture planning, and
  MCP smoke passed.
- Independent completion, quality, and security reviews reported no remaining High/Medium issue.

## Evidence boundary

The live Premiere observations documented in `LIVE-VALIDATION.md` remain the v0.2 baseline. The new
v0.3 mutation, unattended, durable-job, checkpoint, semantic-action, connector, and fixture paths
have offline verification but no enrolled disposable live-host evidence in this release build
environment. Their support states remain unverified, contextual, plan-only, entitlement-blocked, or
unsupported as recorded in the generated matrices.

## Assets

The public release set consists of the Windows ZIP, UDT-produced CCX, SPDX SBOM, third-party notices,
SHA-256 sidecars, and the RSA-signed release manifest/signature. The Windows ZIP contains the bundled
MCP runtime, self-contained native launcher, UXP/CEP bridges, generated registries, complete guides,
installer/update/doctor/uninstall tools, in-package SBOM/notices, and signed integrity manifests.
