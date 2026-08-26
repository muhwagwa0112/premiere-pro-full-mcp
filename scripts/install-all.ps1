param(
    [switch]$RestartDaemon
)
# One-shot setup for the local-first Premiere MCP:
#   1. Register the always-on bridge daemon for logon auto-start (and run it now).
#   2. Deploy the rebuilt CEP extension into Premiere's CEP folder.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "== 1/2: Always-on bridge daemon =="
& (Join-Path $PSScriptRoot "install-daemon.ps1") @([switch]$RestartDaemon)

Write-Host ""
Write-Host "== 2/2: CEP extension =="
& (Join-Path $PSScriptRoot "install-cep.ps1")

Write-Host ""
Write-Host "Done. The bridge daemon now starts automatically at every logon."
Write-Host "Restart Premiere Pro so the rebuilt extension connects to it."
