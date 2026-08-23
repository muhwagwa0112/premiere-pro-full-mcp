[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [string]$CepInstallRoot = '',
    [switch]$CheckLive,
    [switch]$SkipCodexRegistration,
    [switch]$SkipPremiereCheck,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$resolvedInstallRoot = Get-PpMcpInstallRoot -InstallRoot $InstallRoot
$previousInstallRootEnvironment = $env:PREMIERE_MCP_INSTALL_ROOT
$env:PREMIERE_MCP_INSTALL_ROOT = $resolvedInstallRoot
$resolvedCepRoot = Get-PpMcpCepInstallRoot -CepInstallRoot $CepInstallRoot
$checks = New-Object System.Collections.ArrayList
function Add-Check([string]$Name, [bool]$Ok, [string]$Detail, [bool]$Required = $true) { [void]$checks.Add([ordered]@{ name = $Name; ok = $Ok; required = $Required; detail = $Detail }) }

$metadata = Get-PpMcpCurrentMetadata -InstallRoot $resolvedInstallRoot
if (-not $metadata) { Add-Check 'install-metadata' $false 'No installed version metadata was found.' }
else {
    Add-Check 'install-metadata' ($metadata.product -eq $script:PpMcpProduct) "Version $($metadata.version)"
    foreach ($entry in @(@('native-launcher', $metadata.launcher), @('mcp-bundle', $metadata.bundle), @('uxp-manifest', $metadata.manifestPath), @('ccx-package', $metadata.ccxPath))) {
        Add-Check $entry[0] ([bool](Test-Path -LiteralPath ([string]$entry[1]) -PathType Leaf)) ([string]$entry[1])
    }
    $runtimeVerified = $false
    if (Test-Path -LiteralPath ([string]$metadata.launcher) -PathType Leaf) {
        & ([string]$metadata.launcher) --verify-install 2>$null | Out-Null
        $runtimeVerified = $LASTEXITCODE -eq 0
    }
    Add-Check 'signed-runtime-integrity' $runtimeVerified 'RSA-signed bundled Node.js and MCP bundle hashes'
}
Add-Check 'cep-extension' ([bool](Test-Path -LiteralPath (Join-Path $resolvedCepRoot 'CSXS\manifest.xml') -PathType Leaf)) $resolvedCepRoot
if ($SkipPremiereCheck) { Add-Check 'premiere-pro' $true 'Skipped for isolated package verification.' $false }
else {
    $premierePaths = @(@(
        (Join-Path ${env:ProgramFiles} 'Adobe\Adobe Premiere Pro 2026\Adobe Premiere Pro.exe'),
        (Join-Path ${env:ProgramFiles} 'Adobe\Adobe Premiere Pro 2025\Adobe Premiere Pro.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) })
    Add-Check 'premiere-pro' ($premierePaths.Count -gt 0) ($(if ($premierePaths.Count) { $premierePaths -join ', ' } else { 'Adobe Premiere Pro was not found in the standard Program Files locations.' }))
}

if ($SkipCodexRegistration) { Add-Check 'codex-registration' $true 'Skipped for isolated verification.' $false }
elseif ($metadata -and (Get-Command codex -ErrorAction SilentlyContinue)) {
    $registration = @(& codex mcp get $script:PpMcpRegistration 2>$null) -join "`n"
    $ok = $LASTEXITCODE -eq 0 -and $registration.Contains([string]$metadata.launcher) -and $registration.Contains([string]$metadata.bundle)
    Add-Check 'codex-registration' $ok ($(if ($ok) { "$($script:PpMcpRegistration) points to the installed launcher and bundle." } else { 'Registration is missing or points to another runtime.' }))
} else { Add-Check 'codex-registration' $false 'Codex CLI or installed metadata is unavailable.' }

if ($CheckLive -and $metadata) {
    $bootstrap = Join-Path $resolvedInstallRoot 'app\runtime-bootstrap.json'
    Add-Check 'uxp-bootstrap' ([bool](Test-Path -LiteralPath $bootstrap -PathType Leaf)) $bootstrap
    $cepHeartbeat = Join-Path $resolvedInstallRoot 'cep\heartbeat.json'
    $cepFresh = (Test-Path -LiteralPath $cepHeartbeat -PathType Leaf) -and (((Get-Date) - (Get-Item -LiteralPath $cepHeartbeat).LastWriteTime).TotalSeconds -lt 30)
    Add-Check 'cep-heartbeat' $cepFresh ($(if ($cepFresh) { $cepHeartbeat } else { 'No fresh CEP heartbeat was found.' }))
}

$success = -not ($checks | Where-Object { $_.required -and -not $_.ok })
$result = [ordered]@{ ok = $success; installRoot = $resolvedInstallRoot; checks = @($checks) }
if ($Json) { $result | ConvertTo-Json -Depth 6 } else { foreach ($check in $checks) { Write-Host ("[{0}] {1}: {2}" -f $(if ($check.ok) { 'OK' } else { 'FAIL' }), $check.name, $check.detail) } }
$env:PREMIERE_MCP_INSTALL_ROOT = $previousInstallRootEnvironment
if (-not $success) { exit 1 }
