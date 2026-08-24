# Public release checklist

## Blocking gates

- [x] Git worktree is clean and every commit author/committer uses the GitHub noreply address.
- [x] MIT license, Ko-fi link, Funding configuration, security policy, issue forms, and current release links are present.
- [x] Full-history and final-artifact secret/PII scan reports no credential, private key, personal path, project/media name, or personal email.
- [x] `npm audit --omit=dev --audit-level=high` and .NET transitive vulnerability checks pass.
- [x] `npm run check` passes all 33 Vitest files / 201 tests; the Windows UI agent passes all 43 tests.
- [x] Support and feature registry regeneration/checks pass for 51 public actions and 150 feature records.
- [x] MCP smoke, release-security tests, the 761-member UXP plan, and disposable fixture plan pass.
- [x] The final live ledger contains all 761 UXP IDs and does not regress below 281 deterministic successes; failures remain explicit and fail closed.
- [x] CEP heartbeat/QE, named-pipe UI transport, project create/import/sequence/save, frame export, and sequence export pass on the installed release.
- [x] `ZXPSignCmd -verify` accepts the bundled CEP directory, and it loads with `PlayerDebugMode=0` on a clean Premiere restart.
- [x] The CCX is packaged through Adobe UXP Developer Tool (not `Build-Ccx.ps1`) and installed through Creative Cloud Desktop; the panel is visible at minimum, docked, floating, and scaled layouts.
  Adobe UPIA 8.5.0.13 now installs the UDT-produced v0.3.0 CCX and lists it as enabled for
  Premiere Pro 26.3.2. Premiere's UXP menu opened the exact installed plug-in; it automatically
  established the automatic protocol-v3 mutually authenticated local session and exposed its Connect
  retry control in a 340x326 outer
  / 324x287 client window at 96 DPI, with an exact 320x260 nested UXP content view matching the
  manifest minimum. At 125% Windows scale, Premiere reported 120 DPI and the same installed panel
  retained its exact 320x260 content view with the retry control and named panel tab present. The
  panel was then docked into Premiere's main workspace: `dvauxpuiUXPPanel` and the Connect retry
  button appeared under the main `WorkspaceFrame` / `TabPanelContainer` beside the named panel tab,
  with no separate floating panel window. The retained comparison is
  `docs/evidence/ccx-install-layout-v0.3.0.json`.
- [x] A release build without `-CcxPath`, with a development ZIP renamed to `.ccx`, or with a mismatched CCX filename/identity fails before staging or publishing.
- [ ] The signed release ZIP, CCX, SBOM, notices, hashes, manifest, and signature pass `Verify-Release.ps1`.
- [x] Tampered signature, extra ZIP file, path escape, reparse point, case collision, downgrade, and partial-install rollback tests reject safely.
- [x] Independent security audit has no open Critical/High issue and no exploitable Medium issue.
- [ ] Independent completion review confirms no unsupported publication or live-host claim.
- [x] The release notes, README, install/deployment/migration/troubleshooting guides, generated
  matrices, SBOM, notices, and packaged copies all describe the same version and evidence boundary.

## Publication

- [x] Create public `muhwagwa0112/premiere-pro-full-mcp`, enable private vulnerability reporting, secret scanning/push protection, and Dependabot.
- [ ] Push `main`, verify pinned CI, create `v0.3.0`, upload all release assets, and mark it latest.
- [ ] From a logged-out browser, verify README, Ko-fi, license, Security tab, asset names, checksums, and release notes.
- [ ] Download the public asset and complete one final install/Doctor/fresh-process Codex smoke.

## Claim boundary

Inventory coverage is not universal execution coverage. UXP, CEP/QE, UI, entitlement, third-party plug-in, cloud, modal, and state-dependent results are reported independently. A timeout or unavailable host object is never counted as success.
