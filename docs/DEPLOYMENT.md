# Windows deployment

## Release contract

`npm run package:release` builds the TypeScript MCP bundle, publishes the native launcher as self-contained `win-x64`, stages the CEP and UXP bridges, generated Adobe API inventory, source and documentation, writes `MANIFEST.sha256`, normalizes staged timestamps, and creates `release\premiere-pro-2026-local-mcp-<version>-win-x64.zip`.

The archive intentionally excludes `.env`, `node_modules`, coverage, intermediate .NET output, debug symbols, and files named `bootstrap` or `bootstrap.*`. Tokens and session credentials must never be added to the release tree. The installer creates the UXP bootstrap only after the package has been verified and copied into `%LOCALAPPDATA%\PremiereMCP`.

## Required build order

The native launcher's allowlist pins the exact SHA-256 of the MCP bundle. Therefore the final release sequence is:

1. Finish all MCP source changes and run the normal repository checks.
2. Build `bundle\premiere-mcp.bundle.mjs`.
3. Update and verify the native launcher's pinned bundle hash against that exact final bundle.
4. Build/test the native launcher.
5. Run `npm run package:release` without changing the bundle afterward.
6. Extract the ZIP into a clean directory and verify every `MANIFEST.sha256` entry.

Running the packaging command before hash pinning can produce a structurally valid archive that the launcher correctly refuses to execute.

## Install and Codex registration

From the extracted archive:

```powershell
.\Install.ps1
```

The default install changes only current-user paths and leaves Codex configuration untouched. Existing runtime targets are moved to `%LOCALAPPDATA%\PremiereMCP\backups\install-<timestamp>` before copying.

Installed runtime layout:

- `%LOCALAPPDATA%\PremiereMCP\bin` — self-contained native helper
- `%LOCALAPPDATA%\PremiereMCP\bundle` — pinned MCP server bundle
- `%LOCALAPPDATA%\PremiereMCP\generated` — Adobe API catalog
- `%LOCALAPPDATA%\PremiereMCP\uxp-plugin-<version>` — UXP plugin plus provisioned local bootstrap
- `%LOCALAPPDATA%\PremiereMCP\workspace` — default approved media/project/output root

Windows UI Automation calls are isolated in one short-lived worker process per request. Read-only inspection/catalog workers are terminated at a hard deadline and return a retryable `automation_timeout`. A timed-out `ui.invoke` returns non-retryable `automation_outcome_unknown`, because the semantic action may already have reached Premiere and must be verified before any retry.
- `%APPDATA%\Adobe\CEP\extensions\com.local.ppmcp.cep.2026` — CEP/QE bridge

After copying, `Install.ps1` runs the installed helper as `--provision-uxp <installed-uxp-directory>`. This creates local session bootstrap material at install time; it is not shipped in the ZIP. The installer then calls `source\scripts\register-udt-workspace.mjs` to merge the manifest into UDT's `plugins_workspace.json`. Existing plugin entries are retained. Node absence does not roll back the core runtime; the installer prints the exact manifest path for manual registration. `-SkipUdtWorkspaceRegistration` disables the merge deliberately.

To opt into registration:

```powershell
.\Install.ps1 -RegisterCodexMcp -McpName premiere_pro_2026_local
```

Equivalent explicit command after a default install:

```powershell
codex mcp add premiere_pro_2026_local -- "$env:LOCALAPPDATA\PremiereMCP\bin\PremiereMcp.WindowsUiAgent.exe" --launch-mcp "$env:LOCALAPPDATA\PremiereMCP\bundle\premiere-mcp.bundle.mjs"
```

The installer does not silently remove or overwrite an existing MCP registration.

Workspace registration is not plugin loading. Open Adobe UXP Developer Tool and select **Load** or **Load & Watch** for `%LOCALAPPDATA%\PremiereMCP\uxp-plugin-<version>\manifest.json`. Premiere Pro 26.3 or later and its UXP developer mode are required.

Approve an exact pending operation using the installed trusted helper, without relying on the source tree or `npm`:

```powershell
& "$env:LOCALAPPDATA\PremiereMCP\bin\PremiereMcp.WindowsUiAgent.exe" --approval approve <approval-id>
```

## Verification before distribution

- Run `npm run check` and the native test project.
- Run `npm run package:release` and verify it reports a nonzero hashed-file count.
- Extract the ZIP into a clean folder; run `Get-FileHash` for all manifest entries or execute `Install.ps1`, which verifies them before making changes.
- Install into a test Windows user profile; verify the helper-created UXP bootstrap exists only in the installed plugin, not the archive.
- Verify UDT `plugins_workspace.json` retains all pre-existing entries and adds exactly one normalized Premiere manifest entry.
- Run a fresh-process MCP capability check from the installed launcher and bundle paths.
- Start Premiere Pro and validate UXP, CEP/QE, and named-pipe UI health.
- Perform representative read, edit, transaction, save/export, and output postcondition checks only in an approved test workspace.
- Confirm the release contains neither tokens nor development bootstrap files.

The reproducible live evidence and known host-provider limitations for this release are recorded in
`LIVE-VALIDATION.md`. Distribution sign-off must preserve those boundaries; do not restate declaration
coverage as successful execution of every context-dependent Adobe member.

## Rollback and removal

`Uninstall.ps1` removes only this manifest from UDT's workspace and moves active installed folders into `%LOCALAPPDATA%\PremiereMCP\backups\uninstall-<timestamp>` instead of deleting them. Other UDT plugin entries are retained. Use `-KeepUdtWorkspaceRegistration` to leave the entry untouched. Codex configuration remains unchanged unless `-RemoveCodexMcp` is supplied. Restore by moving the archived folders back to their original current-user locations.
