# Troubleshooting

## SmartScreen or unsigned publisher warning

The v0.3.0 executable and PowerShell scripts are not Authenticode-signed. Verify the release URL and published SHA-256 before proceeding. Never bypass a checksum or RSA update-signature failure.

## The UXP panel is missing or blank

Confirm that the CCX version matches the server version, restart Premiere, and open **Window > UXP Plugins > Premiere Pro Full MCP**. Run Doctor. If CCX installation is unavailable, use the UXP Developer Tool fallback from the installation guide. The panel supports 320x260 minimum, docked, floating, and Windows scaling layouts.

If Creative Cloud Desktop reports update error 190 or says no compatible application is installed,
update/repair Creative Cloud Desktop and confirm Premiere 26.3+ is detected before retrying. Do not
rename a development ZIP to `.ccx` or treat UXP Developer Tool loading as proof that the public CCX
installer and packaged layout gates passed.

## A second Codex thread or CLI does not see its tools

The UXP bridge binds a single local port (`localhost:17777`). When another instance already owns it,
the new instance now joins that leader as an authenticated relay instead of dying or degrading to a
dead backend. Restart the affected thread/CLI after updating the server so it loads the relay-aware
bundle (`premiere-mcp.bundle.mjs`) on both the leader and the new instance. If the leader itself
closes, the remaining follower promotes to leader and the panel reconnects automatically. Only the
panel connection still requires the **Window > UXP Plugins > Premiere Pro Full MCP** panel to be open
in Premiere.

## CEP heartbeat is stale

Restart Premiere after installing or updating. Confirm that `%APPDATA%\Adobe\CEP\extensions\com.codex.premiere-pro-full-mcp.cep` contains `CSXS\manifest.xml`, `META-INF\signatures.xml`, and `mimetype`. Do not enable CEP developer mode or copy CEP files from an older release because the package signature, authenticated protocol, and extension ID must match the native broker.

## Update signature verification fails

Delete the downloaded update files and retry. Do not bypass repository, tag, size, digest, or RSA checks. Updates are forward-only by default.

## Reinstall or remove

Run Update with local signed sidecars for a same-version recovery, or run the installed Uninstall script. Uninstall is recoverable and preserves workspace/operation data unless `-RemoveUserData` is explicitly supplied. Remove the CCX from Creative Cloud Desktop separately.

## A durable job requires reconciliation

Do not resume or manually repeat a step whose checkpoint, host dispatch, output commit, or ledger
write has an unknown outcome. Inspect Premiere and any approved output path first. The job record is
deliberately quarantined across restart and automatic redispatch is disabled. A crash-stale job-store
quota lock is also never reaped automatically; recover it only after confirming no MCP process owns
the store and preserving the protected journals for diagnosis.
