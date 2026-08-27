param(
    [switch]$RestartDaemon,
    [switch]$NoDevMode
)
# One-shot setup for the local-first Premiere MCP:
#   1. Register the always-on bridge daemon for logon auto-start (and run it now).
#   2. Deploy the rebuilt CEP extension into Premiere's CEP folder.
#   3. Deploy the UXP bridge plugin into Premiere's UXP folder (handles the
#      UXP-only edits/exports that CEP cannot reach).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "== 1/3: Always-on bridge daemon =="
& (Join-Path $PSScriptRoot "install-daemon.ps1") @([switch]$RestartDaemon)

Write-Host ""
Write-Host "== 2/3: CEP extension (fallback track) =="
& (Join-Path $PSScriptRoot "install-cep.ps1")

Write-Host ""
Write-Host "== 3/3: UXP bridge plugin (primary edit/export track) =="
& (Join-Path $PSScriptRoot "install-uxp.ps1") @([switch]$NoDevMode)

Write-Host ""
Write-Host "Done. The bridge daemon now starts automatically at every logon."
Write-Host "Restart Premiere Pro so the rebuilt extension connects to it."
