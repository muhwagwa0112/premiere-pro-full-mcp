# Windows installation

The supported public install starts from the versioned GitHub Release ZIP, not the source-code ZIP.

1. Download the Windows ZIP and its `.sha256` sidecar from the latest release.
2. Verify the checksum with `Get-FileHash` and extract the archive.
3. Close Premiere Pro, then select the automation boundary explicitly:

   ```powershell
   # Default: exact-plan one-shot dialogs for interactive R2/R3 operations
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -AutomationMode Interactive

   # Enrolled unattended execution: no per-operation approval dialog
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 `
     -AutomationMode TrustedUnattended `
     -TrustProfilePath .\studio-profile.json
   ```

   `IsolatedLab` is also available and requires a profile whose embedded mode is exactly
   `isolated_lab`. Interactive mode rejects profile arguments. An unattended first install
   requires `-TrustProfilePath`; an ID alone cannot enroll authority.
4. Approve the CCX installation in Creative Cloud Desktop, restart Premiere, and open **Window > UXP Plugins > Premiere Pro Full MCP**.
5. The panel connects automatically to the installed localhost bridge on port 17777; **Connect** retries it with one click. There is no token, file picker, or pairing step.
6. Restart Codex and run the installed `Doctor.ps1 -CheckLive`.

The release ZIP is the complete install source. Do not combine its installer with a CCX, bundle,
generated registry, or native helper copied from another commit or version. The signed release
manifest binds the ZIP, CCX, SBOM, notices, repository, tag, and exact source commit.

The installer verifies that `MANIFEST.sha256` exactly describes every file. It rejects extra/missing files, duplicate case-insensitive paths, ADS-style names, path traversal, absolute paths, and reparse points. Installation is staged before activation and restored from a timestamped backup if activation or Codex registration fails.

The native broker validates and DPAPI-protects the Trust Profile after the pinned launcher is
installed. Codex registration receives only `PREMIERE_MCP_AUTOMATION_MODE` and, for unattended
modes, `PREMIERE_MCP_TRUST_PROFILE_ID`; its command remains the native launcher plus the exact
`--launch-mcp` bundle. The installed `current.json` persists the selected mode/profile so Update
does not silently reset to interactive. Because profiles bind the launcher digest, an update that
changes the launcher requires the original profile JSON via `Update.ps1 -TrustProfilePath ...` to
re-enroll; otherwise it fails closed before activation.

The enrollment file is local policy input. Protect it as an administrative artifact and keep its
approved roots and action/capability grants narrow. Enrollment does not make DPAPI a boundary
against another malicious process under the same Windows account.

The public plugin ID is `com.codex.premiere-pro-full-mcp`; the Codex registration is `premiere_pro_full_mcp`. The CEP compatibility extension is installed for the current user as `com.codex.premiere-pro-full-mcp.cep`.

## Verify the installed v0.3 runtime

After installation, Doctor should report matching v0.3 native, bundle, UXP, CEP, and generated
inventory identities. In Codex, use host/capability inspection before dispatching mutations. Durable
compound work is exposed through `premiere_jobs`; inspect the planned DAG and its exact action order
before execution. A job with an unknown dispatch or checkpoint outcome enters
`reconciliation_required` and must not be manually replayed until host/output state is reconciled.

The packaged plan-only fixture is non-mutating. Live fixture execution additionally requires an
enrolled `trusted_unattended` or `isolated_lab` profile, an isolated Premiere host, explicit live
flags, a unique OS-temporary workspace, and a disposable project. User projects are not valid
fixture inputs.

## Manual UXP fallback

If Creative Cloud Desktop cannot install the CCX, open Adobe UXP Developer Tool, add the manifest printed by Doctor, and use Load or Load & Watch. Workspace registration is a development fallback, not the public installation path.
