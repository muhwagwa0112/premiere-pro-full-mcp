# Public release checklist

## Blocking gates

- [ ] Git worktree is clean and every commit author/committer uses the GitHub noreply address.
- [ ] MIT license, Ko-fi link, Funding configuration, security policy, issue forms, and current release links are present.
- [ ] Full-history and final-artifact secret/PII scan reports no credential, private key, personal path, project/media name, or personal email.
- [ ] `npm audit --omit=dev --audit-level=high` and .NET transitive vulnerability checks pass.
- [ ] `npm run check`, coverage, native tests, MCP/security smokes, and UXP full-surface validation pass.
- [ ] The final live ledger contains all 761 UXP IDs and does not regress below 281 deterministic successes; failures remain explicit and fail closed.
- [ ] CEP heartbeat/QE, named-pipe UI, project read/edit/save, frame export, and sequence export pass on the installed release.
- [ ] `ZXPSignCmd -verify` accepts the bundled CEP directory, and it loads with `PlayerDebugMode=0` on a clean Premiere restart.
- [ ] The CCX is packaged through Adobe UXP Developer Tool (not `Build-Ccx.ps1`) and installed through Creative Cloud Desktop; the panel is visible at minimum, docked, floating, and scaled layouts.
- [ ] A release build without `-CcxPath`, with a development ZIP renamed to `.ccx`, or with a mismatched CCX filename/identity fails before staging or publishing.
- [ ] The signed release ZIP, CCX, SBOM, notices, hashes, manifest, and signature pass `Verify-Release.ps1`.
- [ ] Tampered signature, extra ZIP file, path escape, reparse point, case collision, downgrade, and partial-install rollback tests reject safely.
- [ ] Independent security audit has no open Critical/High issue and no exploitable Medium issue.
- [ ] Independent completion review confirms no unsupported publication or live-host claim.

## Publication

- [ ] Create public `muhwagwa0112/premiere-pro-full-mcp`, enable private vulnerability reporting, secret scanning/push protection, and Dependabot.
- [ ] Push `main`, verify pinned CI, create `v0.3.0`, upload all release assets, and mark it latest.
- [ ] From a logged-out browser, verify README, Ko-fi, license, Security tab, asset names, checksums, and release notes.
- [ ] Download the public asset and complete one final install/Doctor/fresh-process Codex smoke.

## Claim boundary

Inventory coverage is not universal execution coverage. UXP, CEP/QE, UI, entitlement, third-party plug-in, cloud, modal, and state-dependent results are reported independently. A timeout or unavailable host object is never counted as success.
