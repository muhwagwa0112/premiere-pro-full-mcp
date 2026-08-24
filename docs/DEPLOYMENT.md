# Windows deployment

## Release contract

Public releases are built from a clean commit with a Premiere-specific RSA signing key. The build produces:

- `premiere-pro-full-mcp-v<version>-windows.zip`
- `premiere-pro-full-mcp-v<version>.ccx`
- ZIP signed manifest and `.sig`
- `.sha256` sidecars
- versioned SPDX SBOM and third-party notices

The release build also requires a checksum-verified [Syft](https://github.com/anchore/syft) executable through `-SyftPath`, `SYFT_PATH`, or the local audit-tools directory. It additionally requires Adobe ZXPSignCmd 4.1.103 win64 with the pinned SHA-256 and a local PKCS#12 signing identity/password protected for the current Windows user. The build creates the CEP signature from clean source, then verifies both the ZXP and extracted CEP directory before staging. The emitted SPDX starts with Syft's native and package inventory, then adds SHA-256 entries for every non-metadata file in the release ZIP.

Generate the private/public key pair once with `npm run release:keygen`. The private key remains under `%LOCALAPPDATA%\PremiereMCP\release-signing-private.xml` with a current-user-only ACL. Only `scripts/install/release-signing-public.xml` is committed.

For the public CCX, add `uxp-plugin/manifest.json` to Adobe UXP Developer Tool and use **Package**. Rename only that UDT-produced result to `premiere-pro-full-mcp-v<version>.ccx`, then run:

```powershell
npm run compliance:generate
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Build-Release.ps1 -CcxPath .\artifacts\premiere-pro-full-mcp-v0.3.0.ccx
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Verify-Release.ps1
```

`Build-Release.ps1` has no CCX fallback: `-CcxPath` is mandatory and is checked before release staging. `npm run uxp:dev-archive` creates only a non-installable `.zip` for source inspection/CI and refuses a `.ccx` output name. The release build rejects a development ZIP renamed to `.ccx` unless every file retains the pinned regular-file attributes produced by the validated Adobe UDT package path. It also refuses a dirty worktree, mismatched private/public key, wrong repository, wrong CCX filename or identity, generated UXP bootstrap, or failed MCP/native build. The signed manifest binds the exact commit, repository, tag, version, platform, architecture, ZIP, CCX, SBOM, and notices. The UDT attribute check is a fail-closed packaging contract, while the retained UDT/UPIA installation evidence establishes the actual packager and installed identity.

The current v0.3 payload also includes the generated 51-action backend support matrix, 150-entry
feature registry, semantic-action and connector-boundary guides, durable-job runtime, and
post-production fixture manifests. Regenerate both inventories and run their `--check` forms before
packaging; never reuse generated files or a CCX from an earlier commit.

## Installation layout

- `%LOCALAPPDATA%\PremiereMCP\bin` — active native launcher and broker
- `%LOCALAPPDATA%\PremiereMCP\bundle` — dependency-bundled MCP entry point
- `%LOCALAPPDATA%\PremiereMCP\generated` — generated Adobe API catalog
- `%LOCALAPPDATA%\PremiereMCP\uxp-plugin-<version>` — UXP bridge source used for development fallback
- `%LOCALAPPDATA%\PremiereMCP\runtime\node` — release-bundled, signed-ledger-verified Node.js runtime
- `%LOCALAPPDATA%\PremiereMCP\app\tools` — Doctor, Update, Uninstall, public release key, and CCX
- `%APPDATA%\Adobe\CEP\extensions\com.codex.premiere-pro-full-mcp.cep` — Adobe ZXP-signed CEP/QE compatibility bridge; installer does not enable CEP developer mode

Existing active targets are moved to timestamped backups before activation. Failure restores the previous targets and Codex configuration. The UXP panel uses a token-free localhost handshake; no runtime bootstrap or pairing file is generated or shipped.

## Update trust chain

The updater is pinned to `muhwagwa0112/premiere-pro-full-mcp`. It downloads the manifest and signature first, verifies the installed public key, then downloads only the exactly bound ZIP. Drafts, prereleases, repository/tag/name/size/digest mismatches, and downgrade or same-version installs are rejected. `-AllowSameVersion` exists only for deliberate recovery with already-authenticated local sidecars.

## Public release order

1. Run all tests, coverage, native tests, inventory, package, dependency, and leak checks.
2. Complete live UXP/CEP/QE/UI validation on Premiere 26.3+.
3. Verify the final signed artifacts with `Verify-Release.ps1`.
4. Complete independent security and completion review.
5. Push the clean noreply-authored history, create `v0.3.0`, and upload every bound asset.
6. Verify the repository and download from a logged-out browser and reinstall the downloaded ZIP.

Upload exactly these ten versioned files; never glob the `artifacts` directory, which may also hold
older releases and local validation captures:

1. `premiere-pro-full-mcp-v<version>-windows.zip`
2. `premiere-pro-full-mcp-v<version>-windows.zip.sha256`
3. `premiere-pro-full-mcp-v<version>-windows.zip.manifest.json`
4. `premiere-pro-full-mcp-v<version>-windows.zip.manifest.json.sig`
5. `premiere-pro-full-mcp-v<version>.ccx`
6. `premiere-pro-full-mcp-v<version>.ccx.sha256`
7. `premiere-pro-full-mcp-v<version>.spdx.json`
8. `premiere-pro-full-mcp-v<version>.spdx.json.sha256`
9. `premiere-pro-full-mcp-v<version>-third-party-notices.txt`
10. `premiere-pro-full-mcp-v<version>-third-party-notices.txt.sha256`

`Verify-Release.ps1` safely expands the final ZIP, validates every signed asset binding, runs the
pinned Adobe `ZXPSignCmd -verify` against packaged and installed CEP directories, compares the
standalone and bundled CCX, performs an isolated installation and Doctor run, rejects a tampered
signature, and exercises recoverable uninstall. A source-tree test pass does not replace this final
artifact boundary test.
