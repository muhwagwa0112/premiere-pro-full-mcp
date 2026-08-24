# Troubleshooting

## SmartScreen or unsigned publisher warning

The v0.3.0 executable and PowerShell scripts are not Authenticode-signed. Verify the release URL and published SHA-256 before proceeding. Never bypass a checksum or RSA update-signature failure.

## The UXP panel is missing or blank

Confirm that the CCX version matches the server version, restart Premiere, and open **Window > UXP Plugins > Premiere Pro Full MCP**. Run Doctor. If CCX installation is unavailable, use the UXP Developer Tool fallback from the installation guide. The panel supports 320x260 minimum, docked, floating, and Windows scaling layouts.

## CEP heartbeat is stale

Restart Premiere after installing or updating. Confirm that `%APPDATA%\Adobe\CEP\extensions\com.codex.premiere-pro-full-mcp.cep` contains `CSXS\manifest.xml`, `META-INF\signatures.xml`, and `mimetype`. Do not enable CEP developer mode or copy CEP files from an older release because the package signature, authenticated protocol, and extension ID must match the native broker.

## Update signature verification fails

Delete the downloaded update files and retry. Do not bypass repository, tag, size, digest, or RSA checks. Updates are forward-only by default.

## Reinstall or remove

Run Update with local signed sidecars for a same-version recovery, or run the installed Uninstall script. Uninstall is recoverable and preserves workspace/operation data unless `-RemoveUserData` is explicitly supplied. Remove the CCX from Creative Cloud Desktop separately.
