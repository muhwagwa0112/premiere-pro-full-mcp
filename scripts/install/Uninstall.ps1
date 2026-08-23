[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [string]$CepInstallRoot = '',
    [switch]$KeepCodexRegistration,
    [switch]$RemoveUserData
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$resolvedInstallRoot = Get-PpMcpInstallRoot -InstallRoot $InstallRoot
$resolvedCepRoot = Get-PpMcpCepInstallRoot -CepInstallRoot $CepInstallRoot
$archiveRoot = Join-Path $resolvedInstallRoot ('backups\uninstall-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
$targets = [ordered]@{
    bin = (Join-Path $resolvedInstallRoot 'bin'); bundle = (Join-Path $resolvedInstallRoot 'bundle')
    generated = (Join-Path $resolvedInstallRoot 'generated'); runtime = (Join-Path $resolvedInstallRoot 'runtime'); app = (Join-Path $resolvedInstallRoot 'app')
    cep = $resolvedCepRoot
}
$metadata = Get-PpMcpCurrentMetadata -InstallRoot $resolvedInstallRoot
if ($metadata -and $metadata.manifestPath) { $targets.uxp = Split-Path -Parent ([string]$metadata.manifestPath) }
foreach ($name in $targets.Keys) {
    $target = Assert-PpMcpSafeRemovalRoot -Path ([string]$targets[$name])
    if (Test-Path -LiteralPath $target) { New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null; Move-Item -LiteralPath $target -Destination (Join-Path $archiveRoot $name) }
}
if (-not $KeepCodexRegistration -and (Get-Command codex -ErrorAction SilentlyContinue)) {
    $null = & codex mcp get $script:PpMcpRegistration 2>$null
    if ($LASTEXITCODE -eq 0) { Invoke-PpMcpCommand -FilePath 'codex' -Arguments @('mcp', 'remove', $script:PpMcpRegistration) -FailureMessage 'Codex MCP removal failed' }
}
if ($RemoveUserData) {
    foreach ($name in @('cep', 'operations', 'approvals', 'workspace')) {
        $target = Join-Path $resolvedInstallRoot $name
        $null = Assert-PpMcpSafeRemovalRoot -Path $target
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    }
}
Write-Host 'Premiere Pro Full MCP runtime was removed from active locations.'
if (Test-Path -LiteralPath $archiveRoot) { Write-Host "Recoverable uninstall archive: $archiveRoot" }
Write-Host 'Remove the Premiere Pro Full MCP CCX separately from Creative Cloud Desktop > Plugins > Manage Plugins.'
