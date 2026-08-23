[CmdletBinding()]
param([string]$OutputPath = '')

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
$pluginRoot = Join-Path $repoRoot 'uxp-plugin'
$manifest = Get-Content -LiteralPath (Join-Path $pluginRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.manifestVersion -ne 5 -or $manifest.id -ne 'com.codex.premiere-pro-full-mcp' -or $manifest.host.app -ne 'premierepro' -or [string]$manifest.version -ne $version) {
    throw 'Premiere UXP manifest identity, host, or version is invalid for CCX packaging.'
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) { $OutputPath = Join-Path $repoRoot "artifacts\premiere-pro-full-mcp-v$version.ccx" }
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$stagingRoot = Join-Path $repoRoot '.release-staging\ccx'
$verificationRoot = Join-Path $repoRoot '.release-staging\ccx-verify'
$zipPath = "$OutputPath.zip"
foreach ($path in @($stagingRoot, $verificationRoot)) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force } }
foreach ($path in @($OutputPath, $zipPath)) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } }
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
foreach ($name in @('manifest.json', 'index.html', 'main.cjs', 'api-catalog.cjs')) {
    $source = Join-Path $pluginRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "UXP package file is missing: $source" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $stagingRoot $name) -Force
}
Compress-Archive -Path (Join-Path $stagingRoot '*') -DestinationPath $zipPath -CompressionLevel Optimal
Move-Item -LiteralPath $zipPath -Destination $OutputPath -Force
New-Item -ItemType Directory -Path $verificationRoot -Force | Out-Null
Copy-Item -LiteralPath $OutputPath -Destination (Join-Path $verificationRoot 'package.zip') -Force
Expand-Archive -LiteralPath (Join-Path $verificationRoot 'package.zip') -DestinationPath (Join-Path $verificationRoot 'expanded') -Force
$verified = Get-Content -LiteralPath (Join-Path $verificationRoot 'expanded\manifest.json') -Raw | ConvertFrom-Json
if ($verified.id -ne $manifest.id -or [string]$verified.version -ne $version -or $verified.host.app -ne 'premierepro') { throw 'Packaged CCX identity does not match the source plugin.' }
Write-Host "Premiere UXP CCX package: $OutputPath"
Write-Host 'For the public release, repackage the same manifest with Adobe UXP Developer Tool and pass that CCX to Build-Release.ps1 -CcxPath.'
