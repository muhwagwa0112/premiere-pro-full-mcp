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
$cepManifestPresent = Test-Path -LiteralPath (Join-Path $resolvedCepRoot 'CSXS\manifest.xml') -PathType Leaf
$cepSignaturePresent = (Test-Path -LiteralPath (Join-Path $resolvedCepRoot 'META-INF\signatures.xml') -PathType Leaf) -and
                       (Test-Path -LiteralPath (Join-Path $resolvedCepRoot 'mimetype') -PathType Leaf)
Add-Check 'cep-extension' ([bool]$cepManifestPresent) $resolvedCepRoot
Add-Check 'cep-package-signature-metadata' ([bool]$cepSignaturePresent) 'Adobe ZXP signature metadata is installed; release verification separately runs ZXPSignCmd.'
if ($SkipPremiereCheck) { Add-Check 'premiere-pro' $true 'Skipped for isolated package verification.' $false }
else {
    $premierePaths = @(@(
        (Join-Path ${env:ProgramFiles} 'Adobe\Adobe Premiere Pro 2026\Adobe Premiere Pro.exe'),
        (Join-Path ${env:ProgramFiles} 'Adobe\Adobe Premiere Pro 2025\Adobe Premiere Pro.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) })
    Add-Check 'premiere-pro' ($premierePaths.Count -gt 0) ($(if ($premierePaths.Count) { $premierePaths -join ', ' } else { 'Adobe Premiere Pro was not found in the standard Program Files locations.' }))
}

function Read-PpMcpCodexRegistration([string]$Name) {
    # codex mcp get prints "Error: ..." to the error stream when a server is
    # missing; behave like a boolean probe instead of surfacing that record.
    $previousErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $captured = New-Object System.Collections.ArrayList
        $null = & codex mcp get $Name 2>&1 | ForEach-Object { [void]$captured.Add([string]$_) }
        if ($LASTEXITCODE -eq 0) { return (-join $captured) }
        return $null
    } finally {
        $ErrorActionPreference = $previousErrorPreference
    }
}

if ($SkipCodexRegistration) { Add-Check 'codex-registration' $true 'Skipped for isolated verification.' $false }
elseif ($metadata -and (Get-Command codex -ErrorAction SilentlyContinue)) {
    # Accept both the installer's underscore registration and the plugin-marketplace
    # hyphen registration. Either one must point at the installed launcher and bundle.
    $acceptedNames = @($script:PpMcpRegistration, $script:PpMcpProduct)
    $matchedName = $null
    foreach ($candidate in $acceptedNames) {
        $registration = Read-PpMcpCodexRegistration $candidate
        if ($null -ne $registration) {
            if ($registration.Contains([string]$metadata.launcher) -and $registration.Contains([string]$metadata.bundle)) {
                $matchedName = $candidate
                break
            }
        }
    }
    $ok = $null -ne $matchedName
    Add-Check 'codex-registration' $ok ($(if ($ok) { "$matchedName points to the installed launcher and bundle." } else { 'Registration is missing or points to another runtime.' }))
} else { Add-Check 'codex-registration' $false 'Codex CLI or installed metadata is unavailable.' }

if ($CheckLive -and $metadata) {
    $uxpPort = 17777
    $configuredPort = [int]($env:PREMIERE_MCP_UXP_PORT)
    if ($configuredPort -gt 0 -and $configuredPort -lt 65536) { $uxpPort = $configuredPort }
    $uxpConnections = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $uxpPort -ErrorAction SilentlyContinue)
    $uxpListener = @($uxpConnections | Where-Object State -eq 'Listen' | Select-Object -First 1)
    $uxpOwner = if ($uxpListener.Count) { Get-CimInstance Win32_Process -Filter "ProcessId=$($uxpListener[0].OwningProcess)" -ErrorAction SilentlyContinue } else { $null }
    $uxpOwnedByRuntime = $uxpOwner -and [string]$uxpOwner.CommandLine -and ([string]$uxpOwner.CommandLine).Contains([string]$metadata.bundle)
    Add-Check 'uxp-listener' ([bool]$uxpOwnedByRuntime) ($(if ($uxpOwnedByRuntime) { "Installed MCP runtime is listening on 127.0.0.1:$uxpPort." } else { "The installed MCP runtime is not listening on 127.0.0.1:$uxpPort." }))
    $uxpSession = $uxpOwnedByRuntime -and @($uxpConnections | Where-Object { $_.State -eq 'Established' -and $_.OwningProcess -eq $uxpListener[0].OwningProcess }).Count -gt 0
    Add-Check 'uxp-panel-session' ([bool]$uxpSession) ($(if ($uxpSession) { 'Premiere UXP panel has an established one-click local session.' } else { 'No established Premiere UXP panel session was found; open the panel and select Connect.' }))
    $cepHeartbeat = Join-Path $resolvedInstallRoot 'cep-public-v1\heartbeat.json'
    $cepFresh = (Test-Path -LiteralPath $cepHeartbeat -PathType Leaf) -and (((Get-Date) - (Get-Item -LiteralPath $cepHeartbeat).LastWriteTime).TotalSeconds -lt 30)
    Add-Check 'cep-heartbeat' $cepFresh ($(if ($cepFresh) { $cepHeartbeat } else { 'No fresh CEP heartbeat was found.' }))
}

$success = -not ($checks | Where-Object { $_.required -and -not $_.ok })
$result = [ordered]@{ ok = $success; installRoot = $resolvedInstallRoot; checks = @($checks) }
if ($Json) { $result | ConvertTo-Json -Depth 6 } else { foreach ($check in $checks) { Write-Host ("[{0}] {1}: {2}" -f $(if ($check.ok) { 'OK' } else { 'FAIL' }), $check.name, $check.detail) } }
$env:PREMIERE_MCP_INSTALL_ROOT = $previousInstallRootEnvironment
if (-not $success) { exit 1 }
