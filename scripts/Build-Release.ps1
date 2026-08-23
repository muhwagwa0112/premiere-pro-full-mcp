[CmdletBinding()]
param(
    [string]$OutputDirectory = '',
    [string]$CcxPath = '',
    [string]$SigningKeyPath = '',
    [string]$SyftPath = '',
    [string]$Repository = 'muhwagwa0112/premiere-pro-full-mcp'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $repoRoot 'scripts\install\Common.ps1')
if ($Repository -ne $script:PpMcpRepository) { throw 'The public release repository is pinned and cannot be overridden.' }
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
$dirty = @(& git -C $repoRoot status --porcelain --untracked-files=all 2>$null)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw 'Public release builds require a clean Git worktree.' }
$commit = [string](& git -C $repoRoot rev-parse HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[a-f0-9]{40}$') { throw 'Could not resolve the exact release commit.' }
$publicKeyPath = Join-Path $repoRoot 'scripts\install\release-signing-public.xml'
if (-not $SigningKeyPath) {
    if ($env:PREMIERE_MCP_RELEASE_SIGNING_PRIVATE_KEY) { $SigningKeyPath = $env:PREMIERE_MCP_RELEASE_SIGNING_PRIVATE_KEY }
    elseif ($env:LOCALAPPDATA) { $SigningKeyPath = Join-Path $env:LOCALAPPDATA 'PremiereMCP\release-signing-private.xml' }
}
Assert-PpMcpReleaseSigningKey -PrivateKeyPath $SigningKeyPath -PublicKeyPath $publicKeyPath
if (-not $SyftPath) {
    if ($env:SYFT_PATH) { $SyftPath = $env:SYFT_PATH }
    elseif ($env:LOCALAPPDATA) { $SyftPath = (Get-ChildItem (Join-Path $env:LOCALAPPDATA 'PremiereMCP\audit-tools\syft-*\syft.exe') -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1).FullName }
}
if (-not $SyftPath -or -not (Test-Path -LiteralPath $SyftPath -PathType Leaf)) { throw 'A checksum-verified Syft executable is required. Pass -SyftPath or set SYFT_PATH.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'artifacts' }
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$stagingRoot = Join-Path $repoRoot '.release-staging'
$bundleName = "premiere-pro-full-mcp-$version"
$bundleRoot = Join-Path $stagingRoot $bundleName
$payloadRoot = Join-Path $bundleRoot 'payload'
$nativePublishRoot = Join-Path $stagingRoot 'native-win-x64'
if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

Invoke-PpMcpCommand -FilePath 'npm.cmd' -Arguments @('run', 'build') -FailureMessage 'MCP build failed'
Invoke-PpMcpCommand -FilePath 'dotnet.exe' -Arguments @('publish', 'windows-ui-agent/PremiereMcp.WindowsUiAgent.csproj', '--configuration', 'Release', '--runtime', 'win-x64', '--self-contained', 'true', '--output', $nativePublishRoot, '/p:DebugType=None', '/p:DebugSymbols=false', '/p:PublishSingleFile=false') -FailureMessage 'Native launcher publish failed'
New-Item -ItemType Directory -Path (Join-Path $payloadRoot 'native') -Force | Out-Null
Copy-Item -LiteralPath $nativePublishRoot -Destination (Join-Path $payloadRoot 'native\win-x64') -Recurse -Force
foreach ($name in @('bundle', 'generated', 'uxp-plugin', 'cep-plugin')) { Copy-Item -LiteralPath (Join-Path $repoRoot $name) -Destination (Join-Path $payloadRoot $name) -Recurse -Force }
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = (& $nodeExecutable --version).TrimStart('v')
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Could not resolve the bundled Node.js runtime version.' }
$nodeTargetDirectory = Join-Path $payloadRoot 'runtime\node'
New-Item -ItemType Directory -Path $nodeTargetDirectory -Force | Out-Null
Copy-Item -LiteralPath $nodeExecutable -Destination (Join-Path $nodeTargetDirectory 'node.exe') -Force
$integrityDirectory = Join-Path $payloadRoot 'integrity'
New-Item -ItemType Directory -Path $integrityDirectory -Force | Out-Null
$runtimeIntegrityPath = Join-Path $integrityDirectory 'runtime-integrity.json'
$runtimeIntegritySignaturePath = "$runtimeIntegrityPath.sig"
$runtimeIntegrity = [ordered]@{
    schema = 'premiere-pro-full-mcp-runtime/1'; product = $script:PpMcpProduct; version = $version; nodeVersion = $nodeVersion
    files = [ordered]@{
        'bundle/premiere-mcp.bundle.mjs' = Get-PpMcpSha256 (Join-Path $payloadRoot 'bundle\premiere-mcp.bundle.mjs')
        'runtime/node/node.exe' = Get-PpMcpSha256 (Join-Path $nodeTargetDirectory 'node.exe')
    }
}
Write-PpMcpJsonAtomic -Path $runtimeIntegrityPath -Value $runtimeIntegrity
Write-PpMcpDetachedSignature -InputPath $runtimeIntegrityPath -SignaturePath $runtimeIntegritySignaturePath -PrivateKeyPath $SigningKeyPath
$bootstrap = Get-ChildItem -LiteralPath (Join-Path $payloadRoot 'uxp-plugin') -Force | Where-Object { $_.Name -match '^runtime-bootstrap\.json$' }
if ($bootstrap) { throw 'Release packaging refused a generated UXP bootstrap.' }

foreach ($tool in @('Common.ps1', 'Install.ps1', 'Doctor.ps1', 'Update.ps1', 'Uninstall.ps1', 'release-signing-public.xml')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot "scripts\install\$tool") -Destination (Join-Path $bundleRoot $tool) -Force
}
foreach ($name in @('README.md', 'LICENSE', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md')) { Copy-Item -LiteralPath (Join-Path $repoRoot $name) -Destination (Join-Path $bundleRoot $name) -Force }
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs') -Destination (Join-Path $bundleRoot 'docs') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'THIRD-PARTY-LICENSES') -Destination (Join-Path $bundleRoot 'THIRD-PARTY-LICENSES') -Recurse -Force

if (-not $CcxPath) {
    $CcxPath = Join-Path $OutputDirectory "premiere-pro-full-mcp-v$version.ccx"
    Invoke-PpMcpCommand -FilePath 'powershell.exe' -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repoRoot 'scripts\Build-Ccx.ps1'), '-OutputPath', $CcxPath) -FailureMessage 'CCX packaging failed'
}
$CcxPath = [System.IO.Path]::GetFullPath($CcxPath)
if ([System.IO.Path]::GetFileName($CcxPath) -ne "premiere-pro-full-mcp-v$version.ccx") { throw 'CCX filename does not match the release version.' }
$ccxZip = Join-Path $stagingRoot 'ccx-validation.zip'
$ccxExpanded = Join-Path $stagingRoot 'ccx-validation'
Copy-Item -LiteralPath $CcxPath -Destination $ccxZip -Force
Expand-Archive -LiteralPath $ccxZip -DestinationPath $ccxExpanded -Force
$ccxManifest = Get-Content -LiteralPath (Join-Path $ccxExpanded 'manifest.json') -Raw | ConvertFrom-Json
if ($ccxManifest.id -ne $script:PpMcpPluginId -or [string]$ccxManifest.version -ne $version -or $ccxManifest.host.app -ne 'premierepro') { throw 'CCX identity does not match this release.' }
Copy-Item -LiteralPath $CcxPath -Destination (Join-Path $bundleRoot "premiere-pro-full-mcp-v$version.ccx") -Force

$syftSbomPath = Join-Path $stagingRoot 'syft.spdx.json'
Invoke-PpMcpCommand -FilePath $SyftPath -Arguments @("dir:$bundleRoot", '-o', "spdx-json=$syftSbomPath", '-q') -FailureMessage 'Syft release inventory failed'
Invoke-PpMcpCommand -FilePath 'node.exe' -Arguments @((Join-Path $repoRoot 'scripts\generate-release-sbom.mjs'), $bundleRoot, $syftSbomPath, (Join-Path $bundleRoot 'SBOM.spdx.json')) -FailureMessage 'Release SPDX SBOM generation failed'

$bundleManifest = [ordered]@{ schema = 'premiere-pro-full-mcp-bundle/1'; product = $script:PpMcpProduct; version = $version; commit = $commit; platform = 'windows'; architecture = 'win-x64' }
Write-PpMcpJsonAtomic -Path (Join-Path $bundleRoot 'release-manifest.json') -Value $bundleManifest
$manifestLines = New-Object System.Collections.ArrayList
$files = @(Get-ChildItem -LiteralPath $bundleRoot -File -Recurse -Force | Sort-Object FullName)
foreach ($file in $files) {
    $relative = $file.FullName.Substring($bundleRoot.Length + 1).Replace('\', '/')
    [void]$manifestLines.Add("$(Get-PpMcpSha256 -Path $file.FullName) *$relative")
}
[System.IO.File]::WriteAllLines((Join-Path $bundleRoot 'MANIFEST.sha256'), @($manifestLines), (New-Object System.Text.UTF8Encoding($false)))
Write-PpMcpDetachedSignature -InputPath (Join-Path $bundleRoot 'MANIFEST.sha256') -SignaturePath (Join-Path $bundleRoot 'MANIFEST.sha256.sig') -PrivateKeyPath $SigningKeyPath
$epoch = Get-Date '2000-01-01T00:00:00Z'
Get-ChildItem -LiteralPath $bundleRoot -Recurse -Force | ForEach-Object { $_.LastWriteTimeUtc = $epoch }

$zipPath = Join-Path $OutputDirectory "premiere-pro-full-mcp-v$version-windows.zip"
$sbomPath = Join-Path $OutputDirectory "premiere-pro-full-mcp-v$version.spdx.json"
$noticesPath = Join-Path $OutputDirectory "premiere-pro-full-mcp-v$version-third-party-notices.txt"
foreach ($path in @($zipPath, "$zipPath.sha256", "$zipPath.manifest.json", "$zipPath.manifest.json.sig", $sbomPath, "$sbomPath.sha256", $noticesPath, "$noticesPath.sha256")) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } }
Compress-Archive -LiteralPath $bundleRoot -DestinationPath $zipPath -CompressionLevel Optimal
Copy-Item -LiteralPath (Join-Path $bundleRoot 'SBOM.spdx.json') -Destination $sbomPath -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'THIRD-PARTY-NOTICES.md') -Destination $noticesPath -Force
$assets = [ordered]@{
    windowsZip = [ordered]@{ name = [System.IO.Path]::GetFileName($zipPath); sha256 = Get-PpMcpSha256 $zipPath; size = (Get-Item $zipPath).Length }
    ccx = [ordered]@{ name = [System.IO.Path]::GetFileName($CcxPath); sha256 = Get-PpMcpSha256 $CcxPath; size = (Get-Item $CcxPath).Length; pluginId = $script:PpMcpPluginId; pluginVersion = $version }
    sbom = [ordered]@{ name = [System.IO.Path]::GetFileName($sbomPath); sha256 = Get-PpMcpSha256 $sbomPath; size = (Get-Item $sbomPath).Length }
    thirdPartyNotices = [ordered]@{ name = [System.IO.Path]::GetFileName($noticesPath); sha256 = Get-PpMcpSha256 $noticesPath; size = (Get-Item $noticesPath).Length }
}
$signedManifestPath = "$zipPath.manifest.json"
$signaturePath = "$signedManifestPath.sig"
$signedManifest = [ordered]@{ schema = 'premiere-pro-full-mcp-release/1'; product = $script:PpMcpProduct; repository = $Repository; tag = "v$version"; version = $version; commit = $commit; platform = 'windows'; architecture = 'win-x64'; signatureAlgorithm = 'rsa-sha256-pkcs1'; keyId = Get-PpMcpSha256 $publicKeyPath; assets = $assets }
Write-PpMcpJsonAtomic -Path $signedManifestPath -Value $signedManifest
Write-PpMcpReleaseSignature -ManifestPath $signedManifestPath -SignaturePath $signaturePath -PrivateKeyPath $SigningKeyPath -PublicKeyPath $publicKeyPath
foreach ($path in @($zipPath, $CcxPath, $sbomPath, $noticesPath)) { "$(Get-PpMcpSha256 $path)  $([System.IO.Path]::GetFileName($path))" | Set-Content -LiteralPath "$path.sha256" -Encoding ASCII }
Write-Host "Release ZIP: $zipPath"
Write-Host "Release CCX: $CcxPath"
Write-Host "Signed manifest: $signedManifestPath"
Write-Host "Signature: $signaturePath"
