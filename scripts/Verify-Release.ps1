[CmdletBinding()]
param(
    [string]$ArchivePath = '',
    [string]$CcxPath = '',
    [string]$ManifestPath = '',
    [string]$SignaturePath = '',
    [string]$SbomPath = '',
    [string]$NoticesPath = '',
    [string]$Repository = 'muhwagwa0112/premiere-pro-full-mcp'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $repoRoot 'scripts\install\Common.ps1')
if ($Repository -ne $script:PpMcpRepository) { throw 'The public release repository is pinned and cannot be overridden.' }
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if (-not $ArchivePath) { $ArchivePath = Join-Path $repoRoot "artifacts\premiere-pro-full-mcp-v$version-windows.zip" }
if (-not $CcxPath) { $CcxPath = Join-Path $repoRoot "artifacts\premiere-pro-full-mcp-v$version.ccx" }
if (-not $SbomPath) { $SbomPath = Join-Path $repoRoot "artifacts\premiere-pro-full-mcp-v$version.spdx.json" }
if (-not $NoticesPath) { $NoticesPath = Join-Path $repoRoot "artifacts\premiere-pro-full-mcp-v$version-third-party-notices.txt" }
$ArchivePath = [System.IO.Path]::GetFullPath($ArchivePath)
$CcxPath = [System.IO.Path]::GetFullPath($CcxPath)
$SbomPath = [System.IO.Path]::GetFullPath($SbomPath)
$NoticesPath = [System.IO.Path]::GetFullPath($NoticesPath)
if (-not $ManifestPath) { $ManifestPath = "$ArchivePath.manifest.json" }
if (-not $SignaturePath) { $SignaturePath = "$ManifestPath.sig" }
$signed = Read-PpMcpSignedReleaseManifest -ManifestPath $ManifestPath -SignaturePath $SignaturePath -ExpectedRepository $Repository -ExpectedTag "v$version"
$bindings = @(
    @($ArchivePath, $signed.assets.windowsZip), @($CcxPath, $signed.assets.ccx),
    @($SbomPath, $signed.assets.sbom), @($NoticesPath, $signed.assets.thirdPartyNotices)
)
foreach ($binding in $bindings) {
    $path = [string]$binding[0]; $asset = $binding[1]
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Signed release asset is missing: $path" }
    if ([System.IO.Path]::GetFileName($path) -ne [string]$asset.name -or (Get-Item -LiteralPath $path).Length -ne [long]$asset.size -or (Get-PpMcpSha256 -Path $path) -ne [string]$asset.sha256) { throw "Signed release asset verification failed: $path" }
}

$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$temporaryRoot = Join-Path $temporaryBase ('premiere-mcp-release-smoke-' + [Guid]::NewGuid().ToString('N'))
$originalLocalAppData = $env:LOCALAPPDATA
$originalInstallRootEnvironment = $env:PREMIERE_MCP_INSTALL_ROOT
if (-not ([System.IO.Path]::GetFullPath($temporaryRoot)).StartsWith($temporaryBase, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe release verification temp path.' }
try {
    $expanded = Join-Path $temporaryRoot 'expanded'
    $isolatedLocalAppData = Join-Path $temporaryRoot 'localappdata'
    $env:LOCALAPPDATA = $isolatedLocalAppData
    $installRoot = Join-Path $isolatedLocalAppData 'PremiereMCP'
    $env:PREMIERE_MCP_INSTALL_ROOT = $installRoot
    $cepRoot = Join-Path $temporaryRoot 'cep-extension'
    New-Item -ItemType Directory -Path $expanded -Force | Out-Null
    Expand-PpMcpSafeArchive -ArchivePath $ArchivePath -DestinationPath $expanded
    $top = @(Get-ChildItem -LiteralPath $expanded -Force)
    if ($top.Count -ne 1 -or -not $top[0].PSIsContainer -or $top[0].Name -ne "premiere-pro-full-mcp-$version") { throw 'Release archive top-level layout is invalid.' }
    $bundle = $top[0].FullName
    foreach ($required in @('Install.ps1', 'Doctor.ps1', 'Update.ps1', 'Uninstall.ps1', 'Common.ps1', 'release-signing-public.xml', 'MANIFEST.sha256', 'MANIFEST.sha256.sig', 'release-manifest.json', 'LICENSE', 'SBOM.spdx.json', 'THIRD-PARTY-NOTICES.md', 'payload\native\win-x64\PremiereMcp.WindowsUiAgent.exe', 'payload\bundle\premiere-mcp.bundle.mjs', 'payload\runtime\node\node.exe', 'payload\integrity\runtime-integrity.json', 'payload\integrity\runtime-integrity.json.sig', 'payload\uxp-plugin\manifest.json', 'payload\cep-plugin\CSXS\manifest.xml', 'payload\cep-plugin\META-INF\signatures.xml', 'payload\cep-plugin\mimetype')) {
        if (-not (Test-Path -LiteralPath (Join-Path $bundle $required))) { throw "Release payload is missing: $required" }
    }
    $bundledCcx = Join-Path $bundle "premiere-pro-full-mcp-v$version.ccx"
    if ((Get-PpMcpSha256 $bundledCcx) -ne (Get-PpMcpSha256 $CcxPath)) { throw 'Bundled and standalone CCX assets differ.' }
    $ccxZip = Join-Path $temporaryRoot 'plugin.zip'; $ccxExpanded = Join-Path $temporaryRoot 'plugin'
    Copy-Item -LiteralPath $CcxPath -Destination $ccxZip -Force
    Expand-PpMcpSafeArchive -ArchivePath $ccxZip -DestinationPath $ccxExpanded
    $ccxManifest = Get-Content -LiteralPath (Join-Path $ccxExpanded 'manifest.json') -Raw | ConvertFrom-Json
    if ($ccxManifest.id -ne $script:PpMcpPluginId -or [string]$ccxManifest.version -ne $version -or $ccxManifest.host.app -ne 'premierepro') { throw 'CCX manifest identity is invalid.' }

    & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $bundle 'Install.ps1') -InstallRoot $installRoot -CepInstallRoot $cepRoot -PackagePath $bundle -SkipCodexRegistration -SkipCcxLaunch
    if ($LASTEXITCODE -ne 0) { throw 'Isolated release installation failed.' }
    $doctor = Join-Path $installRoot 'app\tools\Doctor.ps1'
    & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $doctor -InstallRoot $installRoot -CepInstallRoot $cepRoot -SkipCodexRegistration -SkipPremiereCheck
    if ($LASTEXITCODE -ne 0) { throw 'Installed Doctor reported a failure.' }

    $tamperedManifest = Join-Path $temporaryRoot 'tampered-manifest.json'
    Copy-Item -LiteralPath $ManifestPath -Destination $tamperedManifest -Force
    Add-Content -LiteralPath $tamperedManifest -Value ' '
    $tamperRejected = $false
    try { $null = Read-PpMcpSignedReleaseManifest -ManifestPath $tamperedManifest -SignaturePath $SignaturePath -ExpectedRepository $Repository }
    catch { $tamperRejected = $_.Exception.Message -match 'signature verification failed' }
    if (-not $tamperRejected) { throw 'Tampered signed release metadata was not rejected.' }

    $uninstall = Join-Path $installRoot 'app\tools\Uninstall.ps1'
    & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $uninstall -InstallRoot $installRoot -CepInstallRoot $cepRoot -KeepCodexRegistration
    if ($LASTEXITCODE -ne 0) { throw 'Isolated uninstall failed.' }
    foreach ($removed in @((Join-Path $installRoot 'bin'), (Join-Path $installRoot 'bundle'), $cepRoot)) { if (Test-Path -LiteralPath $removed) { throw "Uninstall left an active runtime target: $removed" } }
    $releaseSigningPrivateKey = if ($originalLocalAppData) { Join-Path $originalLocalAppData 'PremiereMCP\release-signing-private.xml' } else { '' }
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'scripts\Test-ReleaseSecurity.ps1') -ArchivePath $ArchivePath -ManifestPath $ManifestPath -SignaturePath $SignaturePath -PrivateKeyPath $releaseSigningPrivateKey -RequireReleaseArtifacts
    if ($LASTEXITCODE -ne 0) { throw 'Release-boundary security tests failed.' }
    Write-Host "Release verification passed: $ArchivePath"
    Write-Host "Authenticated SHA-256: $(Get-PpMcpSha256 $ArchivePath)"
    Write-Host 'Tampered signature rejection: passed'
    Write-Host 'Isolated install, Doctor, and recoverable uninstall: passed'
} finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    $env:PREMIERE_MCP_INSTALL_ROOT = $originalInstallRootEnvironment
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}
