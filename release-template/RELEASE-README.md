# __PACKAGE_NAME__ __VERSION__ for Windows x64

This archive contains the MCP bundle, generated Adobe API catalog, CEP and UXP bridges, a self-contained native Windows launcher, buildable source, documentation, and a SHA-256 manifest. It contains no session token, bearer secret, `.env`, or development bootstrap file.

## Signature and integrity notice

This release candidate is **not Authenticode-signed**. Windows Defender SmartScreen or PowerShell
may warn before running the launcher or installer. Do not bypass a warning unless the ZIP SHA-256
matches the checksum published with the release and the download came from the expected release page.
An unsigned checksum detects accidental or malicious changes only when the checksum itself is obtained
through a trusted channel; it does not establish publisher identity.

Before extraction, compare the downloaded ZIP with the published value:

```powershell
(Get-FileHash .\__PACKAGE_NAME__-__VERSION__-win-x64.zip -Algorithm SHA256).Hash.ToLowerInvariant()
```

After extraction, verify every staged file against `MANIFEST.sha256`:

```powershell
$failures = foreach ($line in Get-Content .\MANIFEST.sha256) {
  if ($line -notmatch '^([0-9a-f]{64}) \*(.+)$') { "malformed manifest line"; continue }
  $path = Join-Path $PWD $Matches[2].Replace('/', '\')
  if (!(Test-Path -LiteralPath $path)) { "missing: $($Matches[2])"; continue }
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Matches[1]) {
    "hash mismatch: $($Matches[2])"
  }
}
if ($failures) { $failures; throw 'Release integrity verification failed' }
```

## Install

Extract the ZIP to a local directory, open PowerShell in the extracted package root, then run:

```powershell
.\Install.ps1
```

This installs only under the current user's `%LOCALAPPDATA%` and `%APPDATA%`. Existing destinations are moved into a timestamped `%LOCALAPPDATA%\PremiereMCP\backups` directory first.

The installer then asks the installed native helper to create the session bootstrap inside the installed UXP directory. That generated bootstrap contains local session material and is never part of this release archive. If Node.js is available, the installer also merges the installed manifest into Adobe UXP Developer Tool's workspace without replacing existing plugin entries. Use `-SkipUdtWorkspaceRegistration` to skip that merge.

To also add the stdio server to Codex:

```powershell
.\Install.ps1 -RegisterCodexMcp
```

The installer does not replace an existing registration. Remove or rename the existing MCP registration deliberately before retrying.

Open Adobe UXP Developer Tool and use **Load** or **Load & Watch** for the registered Premiere manifest. Workspace registration does not itself load the plugin. The CEP extension is installed into the current user's Adobe CEP extension directory.

For an approval ID returned by an R2/R3 preview, launch the trusted dialog directly through the installed helper:

```powershell
& "$env:LOCALAPPDATA\PremiereMCP\bin\PremiereMcp.WindowsUiAgent.exe" --approval approve <approval-id>
```

## Uninstall

```powershell
.\Uninstall.ps1
```

Uninstall is recoverable: active runtime directories are moved to a timestamped backup, and only this version's UDT workspace entry is removed. Add `-KeepUdtWorkspaceRegistration` to retain that entry or `-RemoveCodexMcp` when the Codex registration should also be removed.

See `docs\DEPLOYMENT.md` for build ordering, integrity verification, host requirements, and release checks.
