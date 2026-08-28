param(
    [switch]$RestartDaemon,
    [switch]$NoDevMode,
    [switch]$QuarantineKnownLegacyCep
)
# One-shot setup for the local-first Premiere MCP:
#   1. Register the always-on bridge daemon for logon auto-start (and run it now).
#   2. Deploy the rebuilt CEP extension into Premiere's CEP folder.
#   3. Deploy the UXP bridge plugin into Premiere's UXP folder (handles the
#      UXP-only edits/exports that CEP cannot reach).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# Fail before daemon registration/restart if the current CEP replacement is
# incomplete or a known legacy bundle requires an explicit quarantine decision.
Write-Host "== Preflight: CEP source and legacy conflict audit =="
if ($QuarantineKnownLegacyCep) {
    & (Join-Path $PSScriptRoot "install-cep.ps1") -AuditOnly -QuarantineKnownLegacyCep
} else {
    & (Join-Path $PSScriptRoot "install-cep.ps1") -AuditOnly
}
Write-Host ""
Write-Host "== Preflight: UXP source audit =="
& (Join-Path $PSScriptRoot "install-uxp.ps1") -AuditOnly
Write-Host ""

Write-Host "== 1/3: Always-on bridge daemon =="
if ($RestartDaemon) {
    & (Join-Path $PSScriptRoot "install-daemon.ps1") -Restart
} else {
    & (Join-Path $PSScriptRoot "install-daemon.ps1")
}

Write-Host ""
Write-Host "== 2/3: CEP extension (fallback track) =="
if ($QuarantineKnownLegacyCep) {
    & (Join-Path $PSScriptRoot "install-cep.ps1") -QuarantineKnownLegacyCep
} else {
    & (Join-Path $PSScriptRoot "install-cep.ps1")
}

Write-Host ""
Write-Host "== 3/3: UXP bridge plugin (primary edit/export track) =="
if ($NoDevMode) {
    & (Join-Path $PSScriptRoot "install-uxp.ps1") -NoDevMode
} else {
    & (Join-Path $PSScriptRoot "install-uxp.ps1")
}

Write-Host ""
Write-Host "Done. The bridge daemon now starts automatically at every logon."
Write-Host "Restart Premiere Pro so the rebuilt extension connects to it."
