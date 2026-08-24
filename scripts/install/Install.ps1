[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [string]$CepInstallRoot = '',
    [string]$PackagePath = '',
    [ValidateSet('interactive', 'trusted_unattended', 'TrustedUnattended', 'isolated_lab', 'IsolatedLab')][string]$AutomationMode = 'interactive',
    [string]$TrustProfileId = '',
    [string]$TrustProfilePath = '',
    [switch]$SkipCodexRegistration,
    [switch]$SkipCcxLaunch
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$AutomationMode = Resolve-PpMcpAutomationMode -AutomationMode $AutomationMode
$packageRoot = if ($PackagePath) { [System.IO.Path]::GetFullPath($PackagePath) } else { [System.IO.Path]::GetFullPath((Split-Path -Parent $PSCommandPath)) }
$resolvedInstallRoot = Get-PpMcpInstallRoot -InstallRoot $InstallRoot
$existingMetadata = Get-PpMcpCurrentMetadata -InstallRoot $resolvedInstallRoot
$trustEnrollment = $null
$reuseInstalledTrustProfile = $false
if ($AutomationMode -eq 'interactive') {
    if ($TrustProfileId -or $TrustProfilePath) { throw 'Interactive mode cannot use a trust profile ID or enrollment file.' }
} else {
    if ($TrustProfilePath) {
        $trustEnrollment = Read-PpMcpTrustProfileEnrollment -TrustProfilePath $TrustProfilePath -AutomationMode $AutomationMode
        if ($TrustProfileId -and $TrustProfileId -cne $trustEnrollment.profileId) { throw 'Trust profile ID does not match the enrollment file.' }
        $TrustProfileId = $trustEnrollment.profileId
    } else {
        $TrustProfileId = Assert-PpMcpTrustProfileId -TrustProfileId $TrustProfileId
        if (-not $existingMetadata -or [string]$existingMetadata.automationMode -cne $AutomationMode -or [string]$existingMetadata.trustProfileId -cne $TrustProfileId) {
            throw "$AutomationMode requires -TrustProfilePath for initial enrollment or a matching installed profile configuration."
        }
        $reuseInstalledTrustProfile = $true
    }
}
$previousInstallRootEnvironment = $env:PREMIERE_MCP_INSTALL_ROOT
$env:PREMIERE_MCP_INSTALL_ROOT = $resolvedInstallRoot
$resolvedCepRoot = Get-PpMcpCepInstallRoot -CepInstallRoot $CepInstallRoot
$releaseMetadataPath = Join-Path $packageRoot 'release-manifest.json'
$hashManifestPath = Join-Path $packageRoot 'MANIFEST.sha256'
$hashManifestSignaturePath = Join-Path $packageRoot 'MANIFEST.sha256.sig'
foreach ($required in @($releaseMetadataPath, $hashManifestPath, $hashManifestSignaturePath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Release package is missing: $required" }
}
Assert-PpMcpDetachedSignature -InputPath $hashManifestPath -SignaturePath $hashManifestSignaturePath
$releaseMetadata = Get-Content -LiteralPath $releaseMetadataPath -Raw | ConvertFrom-Json
$version = [string]$releaseMetadata.version
if ($releaseMetadata.schema -ne 'premiere-pro-full-mcp-bundle/1' -or $releaseMetadata.product -ne $script:PpMcpProduct -or $version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw 'Release package metadata is invalid.'
}

$expectedFiles = @{}
foreach ($line in Get-Content -LiteralPath $hashManifestPath) {
    if ($line -notmatch '^([a-f0-9]{64}) \*(.+)$') { throw "Invalid MANIFEST.sha256 entry: $line" }
    $relativeRaw = $Matches[2]
    $segments = @($relativeRaw -split '[\\/]')
    if ($relativeRaw -match '^[\\/]' -or $relativeRaw.Contains(':') -or ($segments -contains '..') -or ($segments -contains '.')) { throw "Unsafe manifest path: $relativeRaw" }
    $relative = $relativeRaw.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $packageRoot $relative))
    $prefix = $packageRoot.TrimEnd('\') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Manifest path escapes the package: $relativeRaw" }
    if ($expectedFiles.ContainsKey($candidate.ToLowerInvariant())) { throw "Duplicate manifest path: $relativeRaw" }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Manifest file is missing: $relativeRaw" }
    if ((Get-PpMcpSha256 -Path $candidate) -ne $Matches[1]) { throw "Package integrity check failed: $relativeRaw" }
    $expectedFiles[$candidate.ToLowerInvariant()] = $true
}
$reparseEntries = @(Get-ChildItem -LiteralPath $packageRoot -Recurse -Force | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint })
if ($reparseEntries.Count) { throw "Reparse points are not allowed in a release package: $($reparseEntries[0].FullName)" }
$actualFiles = @(Get-ChildItem -LiteralPath $packageRoot -File -Recurse -Force | Where-Object { $_.FullName -ne $hashManifestPath -and $_.FullName -ne $hashManifestSignaturePath })
foreach ($file in $actualFiles) {
    if (-not $expectedFiles.ContainsKey($file.FullName.ToLowerInvariant())) { throw "Unlisted file in release package: $($file.FullName)" }
}
if ($actualFiles.Count -ne $expectedFiles.Count) { throw 'Release package file count does not match MANIFEST.sha256.' }

$payloadRoot = Join-Path $packageRoot 'payload'
$nativeSource = Join-Path $payloadRoot 'native\win-x64'
$bundleSource = Join-Path $payloadRoot 'bundle'
$generatedSource = Join-Path $payloadRoot 'generated'
$runtimeSource = Join-Path $payloadRoot 'runtime'
$integritySource = Join-Path $payloadRoot 'integrity'
$uxpSource = Join-Path $payloadRoot 'uxp-plugin'
$cepSource = Join-Path $payloadRoot 'cep-plugin'
$ccxSource = Join-Path $packageRoot "premiere-pro-full-mcp-v$version.ccx"
foreach ($required in @($nativeSource, $bundleSource, $generatedSource, $runtimeSource, $integritySource, $uxpSource, $cepSource)) {
    if (-not (Test-Path -LiteralPath $required -PathType Container)) { throw "Release payload is missing: $required" }
}
if (-not (Test-Path -LiteralPath $ccxSource -PathType Leaf)) { throw 'Release payload is missing the expected CCX package.' }
if ($reuseInstalledTrustProfile) {
    $existingLauncher = [string]$existingMetadata.launcher
    $nextLauncher = Join-Path $nativeSource 'PremiereMcp.WindowsUiAgent.exe'
    if (-not (Test-Path -LiteralPath $existingLauncher -PathType Leaf) -or -not (Test-Path -LiteralPath $nextLauncher -PathType Leaf) -or
        (Get-PpMcpSha256 -Path $existingLauncher) -cne (Get-PpMcpSha256 -Path $nextLauncher)) {
        throw 'The launcher identity changed; unattended mode requires -TrustProfilePath to re-enroll the profile for this update.'
    }
}

$stageRoot = Join-Path $resolvedInstallRoot ('.install-stage-' + [Guid]::NewGuid().ToString('N'))
$backupRoot = Join-Path $resolvedInstallRoot ('backups\install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
$toolsSource = $packageRoot
$destinations = [ordered]@{
    bin = (Join-Path $resolvedInstallRoot 'bin')
    bundle = (Join-Path $resolvedInstallRoot 'bundle')
    generated = (Join-Path $resolvedInstallRoot 'generated')
    runtime = (Join-Path $resolvedInstallRoot 'runtime')
    uxp = (Join-Path $resolvedInstallRoot "uxp-plugin-$version")
    app = (Join-Path $resolvedInstallRoot 'app')
    cep = $resolvedCepRoot
}
$defaultInstallRoot = if ($env:LOCALAPPDATA) { [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'PremiereMCP')) } else { '' }
$defaultCepRoot = if ($env:APPDATA) { [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.codex.premiere-pro-full-mcp.cep')) } else { '' }
$isActiveUserInstall = $defaultInstallRoot -and $defaultCepRoot -and
    [System.IO.Path]::GetFullPath($resolvedInstallRoot).Equals($defaultInstallRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
    [System.IO.Path]::GetFullPath($resolvedCepRoot).Equals($defaultCepRoot, [System.StringComparison]::OrdinalIgnoreCase)
$runningPremiere = @($(if ($isActiveUserInstall) { Get-Process -Name 'Adobe Premiere Pro' -ErrorAction SilentlyContinue }))
$runningBridge = @(Get-CimInstance Win32_Process -Filter "Name='PremiereMcp.WindowsUiAgent.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and [System.IO.Path]::GetFullPath([string]$_.ExecutablePath).StartsWith(([System.IO.Path]::GetFullPath($resolvedInstallRoot) + [System.IO.Path]::DirectorySeparatorChar), [System.StringComparison]::OrdinalIgnoreCase)
})
if ($runningPremiere.Count -gt 0 -or $runningBridge.Count -gt 0) {
    throw 'Close Premiere Pro and any Premiere Pro Full MCP helper process before installing or updating. No files were changed.'
}
$backedUp = New-Object System.Collections.ArrayList
$activated = New-Object System.Collections.ArrayList
$codexConfigPath = Get-PpMcpCodexConfigPath
$codexConfigBackup = Join-Path $stageRoot 'codex-config.before'
$hadCodexConfig = $false
$trustProfileTarget = if ($trustEnrollment) { Join-Path (Join-Path $env:LOCALAPPDATA 'PremiereMCP\trust-profiles') ($TrustProfileId + '.dpapi') } else { '' }
$trustProfileBackup = Join-Path $stageRoot 'trust-profile.before'
$hadTrustProfile = $false
try {
    New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
    Copy-Item -LiteralPath $nativeSource -Destination (Join-Path $stageRoot 'bin') -Recurse -Force
    Copy-Item -LiteralPath $bundleSource -Destination (Join-Path $stageRoot 'bundle') -Recurse -Force
    Copy-Item -LiteralPath $generatedSource -Destination (Join-Path $stageRoot 'generated') -Recurse -Force
    Copy-Item -LiteralPath $runtimeSource -Destination (Join-Path $stageRoot 'runtime') -Recurse -Force
    New-Item -ItemType Directory -Path (Join-Path $stageRoot 'app') -Force | Out-Null
    Copy-Item -LiteralPath $integritySource -Destination (Join-Path $stageRoot 'app\integrity') -Recurse -Force
    Copy-Item -LiteralPath $uxpSource -Destination (Join-Path $stageRoot 'uxp') -Recurse -Force
    Copy-Item -LiteralPath $cepSource -Destination (Join-Path $stageRoot 'cep') -Recurse -Force
    $toolsStage = Join-Path $stageRoot 'app\tools'
    New-Item -ItemType Directory -Path (Join-Path $toolsStage 'packages') -Force | Out-Null
    foreach ($tool in @('Common.ps1', 'Doctor.ps1', 'Update.ps1', 'Uninstall.ps1', 'release-signing-public.xml')) {
        Copy-Item -LiteralPath (Join-Path $toolsSource $tool) -Destination (Join-Path $toolsStage $tool) -Force
    }
    Copy-Item -LiteralPath $ccxSource -Destination (Join-Path $toolsStage "packages\premiere-pro-full-mcp-v$version.ccx") -Force

    foreach ($name in $destinations.Keys) {
        $target = [string]$destinations[$name]
        $null = Assert-PpMcpSafeRemovalRoot -Path $target
        if (Test-Path -LiteralPath $target) {
            New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
            $backup = Join-Path $backupRoot $name
            Move-Item -LiteralPath $target -Destination $backup
            [void]$backedUp.Add([ordered]@{ target = $target; backup = $backup })
        }
    }

    $stageMap = [ordered]@{ bin = 'bin'; bundle = 'bundle'; generated = 'generated'; runtime = 'runtime'; uxp = 'uxp'; app = 'app'; cep = 'cep' }
    foreach ($name in $destinations.Keys) {
        $target = [string]$destinations[$name]
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Move-Item -LiteralPath (Join-Path $stageRoot $stageMap[$name]) -Destination $target
        [void]$activated.Add($target)
    }

    $launcher = Join-Path $destinations.bin 'PremiereMcp.WindowsUiAgent.exe'
    $bundle = Join-Path $destinations.bundle 'premiere-mcp.bundle.mjs'
    $manifest = Join-Path $destinations.uxp 'manifest.json'
    $installedCcx = Join-Path $destinations.app "tools\packages\premiere-pro-full-mcp-v$version.ccx"
    $current = [ordered]@{
        schema = 'premiere-pro-full-mcp-install/1'; product = $script:PpMcpProduct; version = $version
        installedAtUtc = [DateTime]::UtcNow.ToString('o'); launcher = $launcher; bundle = $bundle
        manifestPath = $manifest; cepPath = $resolvedCepRoot; ccxPath = $installedCcx
        automationMode = $AutomationMode; trustProfileId = $(if ($TrustProfileId) { $TrustProfileId } else { $null })
        doctorPath = (Join-Path $destinations.app 'tools\Doctor.ps1'); updatePath = (Join-Path $destinations.app 'tools\Update.ps1')
    }
    Write-PpMcpJsonAtomic -Path (Join-Path $resolvedInstallRoot 'app\current.json') -Value $current
    New-Item -ItemType Directory -Path (Join-Path $resolvedInstallRoot 'workspace') -Force | Out-Null
    if (-not $SkipCodexRegistration) {
        if ($codexConfigPath -and (Test-Path -LiteralPath $codexConfigPath -PathType Leaf)) { Copy-Item -LiteralPath $codexConfigPath -Destination $codexConfigBackup -Force; $hadCodexConfig = $true }
        Set-PpMcpCodexRegistration -Launcher $launcher -Bundle $bundle -InstallRoot $resolvedInstallRoot -AutomationMode $AutomationMode -TrustProfileId $TrustProfileId
    }
    if ($trustEnrollment) {
        if (Test-Path -LiteralPath $trustProfileTarget -PathType Leaf) { Copy-Item -LiteralPath $trustProfileTarget -Destination $trustProfileBackup -Force; $hadTrustProfile = $true }
        Invoke-PpMcpCommand -FilePath $launcher -Arguments @('--trust-profile', 'enroll', $trustEnrollment.path) -FailureMessage 'Trust profile enrollment failed'
    }
    if (-not $SkipCcxLaunch) { Start-Process -FilePath $installedCcx }
} catch {
    for ($index = $activated.Count - 1; $index -ge 0; $index--) {
        $target = [string]$activated[$index]
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue }
    }
    for ($index = $backedUp.Count - 1; $index -ge 0; $index--) {
        $item = $backedUp[$index]
        if (Test-Path -LiteralPath $item.backup) { New-Item -ItemType Directory -Path (Split-Path -Parent $item.target) -Force | Out-Null; Move-Item -LiteralPath $item.backup -Destination $item.target }
    }
    if (-not $SkipCodexRegistration -and $codexConfigPath) {
        if ($hadCodexConfig -and (Test-Path -LiteralPath $codexConfigBackup -PathType Leaf)) { Copy-Item -LiteralPath $codexConfigBackup -Destination $codexConfigPath -Force }
        elseif (-not $hadCodexConfig -and (Test-Path -LiteralPath $codexConfigPath -PathType Leaf)) { Remove-Item -LiteralPath $codexConfigPath -Force }
    }
    if ($trustEnrollment) {
        if ($hadTrustProfile -and (Test-Path -LiteralPath $trustProfileBackup -PathType Leaf)) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $trustProfileTarget) -Force | Out-Null
            Copy-Item -LiteralPath $trustProfileBackup -Destination $trustProfileTarget -Force
        } elseif (-not $hadTrustProfile -and (Test-Path -LiteralPath $trustProfileTarget -PathType Leaf)) {
            Remove-Item -LiteralPath $trustProfileTarget -Force
        }
    }
    throw
} finally {
    if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
    $env:PREMIERE_MCP_INSTALL_ROOT = $previousInstallRootEnvironment
}

# v0.3.0 no longer accepts a UXP shared token. Retire only the exact legacy
# secret and bootstrap filenames after activation has succeeded, including
# copies moved into this product's timestamped install/uninstall archives.
$deprecatedUxpSecret = Join-Path $resolvedInstallRoot 'secrets\uxp-bridge-token.dpapi'
if (Test-Path -LiteralPath $deprecatedUxpSecret -PathType Leaf) { Remove-Item -LiteralPath $deprecatedUxpSecret -Force }
$backupBase = Join-Path $resolvedInstallRoot 'backups'
if (Test-Path -LiteralPath $backupBase -PathType Container) {
    foreach ($archive in @(Get-ChildItem -LiteralPath $backupBase -Directory -Force)) {
        $deprecatedBootstrap = Join-Path $archive.FullName 'app\runtime-bootstrap.json'
        if (Test-Path -LiteralPath $deprecatedBootstrap -PathType Leaf) { Remove-Item -LiteralPath $deprecatedBootstrap -Force }
    }
}

Write-Host "Installed Premiere Pro Full MCP $version for the current Windows user."
if (Test-Path -LiteralPath $backupRoot) { Write-Host "Previous files were backed up to: $backupRoot" }
Write-Host "Codex registration: $(if ($SkipCodexRegistration) { 'skipped' } else { $script:PpMcpRegistration })"
Write-Host "Automation mode: $AutomationMode"
Write-Host "Doctor: powershell -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $destinations.app 'tools\Doctor.ps1')`""
if (-not $SkipCcxLaunch) {
    Write-Host 'The Premiere UXP CCX was opened in Adobe Creative Cloud Desktop. Approve the Adobe installation prompt to finish.'
} else { Write-Host "CCX launch skipped. Open later: $(Join-Path $destinations.app "tools\packages\premiere-pro-full-mcp-v$version.ccx")" }
