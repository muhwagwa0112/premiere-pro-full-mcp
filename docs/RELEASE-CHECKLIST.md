# Public release checklist

## Required before a public push

- [ ] The owner selects a project license and adds `LICENSE`; do not infer a license from dependencies.
- [ ] The owner supplies the public Git remote and enables GitHub Security Advisories or another private reporting channel.
- [ ] Review `THIRD-PARTY-NOTICES.md`, `THIRD-PARTY-LICENSES/`, and `SBOM.spdx.json` after `npm run compliance:generate`.
- [ ] Run `npm ci`, `npm run inventory:adobe`, `npm run check`, `npm run test:coverage`, and the native .NET tests.
- [ ] With the isolated Premiere fixture open and UXP loaded, run `npm run validate:uxp-full -- --ledger <outside-repository-path>`.
- [ ] Run MCP and security smoke tests and confirm no secret or absolute user path is present in tracked files or the release stage.
- [ ] Run `npm run package:release`; verify `MANIFEST.sha256`, create/update `release/SHA256SUMS.txt`, and test installation from the ZIP.
- [ ] Review the staged Git allowlist. Never commit `artifacts/`, `release/`, `bundle/`, native publish output, tokens, bootstrap files, screenshots, or live ledgers.
- [ ] Sign the Windows binaries and PowerShell scripts, or clearly label the release as unsigned and document SHA-256 verification and SmartScreen expectations.
- [ ] Create an annotated version tag only after the release commit and artifact checksum are final.

## Claim boundary

Report catalog presence, live execution success, live fail-closed results, preview-only entries, and skipped entries separately. Never describe catalog coverage as 761 successful live executions.
