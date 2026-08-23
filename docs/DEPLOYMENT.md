# Windows deployment

## Release contract

Public releases are built from a clean commit with a Premiere-specific RSA signing key. The build produces:

- `premiere-pro-full-mcp-v<version>-windows.zip`
- `premiere-pro-full-mcp-v<version>.ccx`
- ZIP signed manifest and `.sig`
- `.sha256` sidecars
- versioned SPDX SBOM and third-party notices

Generate the private/public key pair once with `npm run release:keygen`. The private key remains under `%LOCALAPPDATA%\PremiereMCP\release-signing-private.xml` with a current-user-only ACL. Only `scripts/install/release-signing-public.xml` is committed.

For the public CCX, add `uxp-plugin/manifest.json` to Adobe UXP Developer Tool and use Package. Name the result `premiere-pro-full-mcp-v<version>.ccx`, then run:

```powershell
npm run compliance:generate
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Build-Release.ps1 -CcxPath .\artifacts\premiere-pro-full-mcp-v0.2.0.ccx
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Verify-Release.ps1
```

The release build refuses a dirty worktree, mismatched private/public key, wrong repository, wrong CCX identity, generated UXP bootstrap, or failed MCP/native build. The signed manifest binds the exact commit, repository, tag, version, platform, architecture, ZIP, CCX, SBOM, and notices.

## Installation layout

- `%LOCALAPPDATA%\PremiereMCP\bin` — active native launcher and broker
- `%LOCALAPPDATA%\PremiereMCP\bundle` — dependency-bundled MCP entry point
- `%LOCALAPPDATA%\PremiereMCP\generated` — generated Adobe API catalog
- `%LOCALAPPDATA%\PremiereMCP\uxp-plugin-<version>` — UXP bridge source used for development fallback
- `%LOCALAPPDATA%\PremiereMCP\runtime\node` — release-bundled, signed-ledger-verified Node.js runtime
- `%LOCALAPPDATA%\PremiereMCP\app\runtime-bootstrap.json` — current-user ACL-protected pairing file selected once by the installed CCX
- `%LOCALAPPDATA%\PremiereMCP\app\tools` — Doctor, Update, Uninstall, public release key, and CCX
- `%APPDATA%\Adobe\CEP\extensions\com.codex.premiere-pro-full-mcp.cep` — CEP/QE compatibility bridge

Existing active targets are moved to timestamped backups before activation. Failure restores the previous targets and Codex configuration. Runtime bootstrap/session data is generated only after installation and is never shipped.

## Update trust chain

The updater is pinned to `muhwagwa0112/premiere-pro-full-mcp`. It downloads the manifest and signature first, verifies the installed public key, then downloads only the exactly bound ZIP. Drafts, prereleases, repository/tag/name/size/digest mismatches, and downgrade or same-version installs are rejected. `-AllowSameVersion` exists only for deliberate recovery with already-authenticated local sidecars.

## Public release order

1. Run all tests, coverage, native tests, inventory, package, dependency, and leak checks.
2. Complete live UXP/CEP/QE/UI validation on Premiere 26.3+.
3. Verify the final signed artifacts with `Verify-Release.ps1`.
4. Complete independent security and completion review.
5. Push the clean noreply-authored history, create `v0.2.0`, and upload every bound asset.
6. Verify the repository and download from a logged-out browser and reinstall the downloaded ZIP.
