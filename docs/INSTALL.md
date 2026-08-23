# Windows installation

The supported public install starts from the versioned GitHub Release ZIP, not the source-code ZIP.

1. Download the Windows ZIP and its `.sha256` sidecar from the latest release.
2. Verify the checksum with `Get-FileHash` and extract the archive.
3. Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1`.
4. Approve the CCX installation in Creative Cloud Desktop, restart Premiere, and open **Window > UXP Plugins > Premiere Pro Full MCP**.
5. Click **Pair with installed helper…** and select `%LOCALAPPDATA%\PremiereMCP\app\runtime-bootstrap.json`. The persistent UXP permission references that current-user ACL-protected file; no bootstrap is packaged in the CCX.
6. Restart Codex and run the installed `Doctor.ps1 -CheckLive`.

The installer verifies that `MANIFEST.sha256` exactly describes every file. It rejects extra/missing files, duplicate case-insensitive paths, ADS-style names, path traversal, absolute paths, and reparse points. Installation is staged before activation and restored from a timestamped backup if activation or Codex registration fails.

The public plugin ID is `com.codex.premiere-pro-full-mcp`; the Codex registration is `premiere_pro_full_mcp`. The CEP compatibility extension is installed for the current user as `com.codex.premiere-pro-full-mcp.cep`.

## Manual UXP fallback

If Creative Cloud Desktop cannot install the CCX, open Adobe UXP Developer Tool, add the manifest printed by Doctor, and use Load or Load & Watch. Workspace registration is a development fallback, not the public installation path.
