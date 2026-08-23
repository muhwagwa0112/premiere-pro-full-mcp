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
if ([string]::IsNullOrWhiteSpace($OutputPath)) { $OutputPath = Join-Path $repoRoot "artifacts\premiere-pro-full-mcp-v$version-uxp-dev-archive.zip" }
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if ([System.IO.Path]::GetExtension($OutputPath) -ne '.zip') { throw 'Development UXP archives must use .zip. Only Adobe UXP Developer Tool may produce a release .ccx.' }
$stagingRoot = Join-Path $repoRoot '.release-staging\uxp-dev-archive'
$verificationRoot = Join-Path $repoRoot '.release-staging\uxp-dev-archive-verify'
foreach ($path in @($stagingRoot, $verificationRoot)) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force } }
if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
foreach ($name in @('manifest.json', 'index.html', 'main.cjs', 'api-catalog.cjs')) {
    $source = Join-Path $pluginRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "UXP package file is missing: $source" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $stagingRoot $name) -Force
}
Compress-Archive -Path (Join-Path $stagingRoot '*') -DestinationPath $OutputPath -CompressionLevel Optimal
New-Item -ItemType Directory -Path $verificationRoot -Force | Out-Null
Expand-Archive -LiteralPath $OutputPath -DestinationPath (Join-Path $verificationRoot 'expanded') -Force
$verified = Get-Content -LiteralPath (Join-Path $verificationRoot 'expanded\manifest.json') -Raw | ConvertFrom-Json
if ($verified.id -ne $manifest.id -or [string]$verified.version -ne $version -or $verified.host.app -ne 'premierepro') { throw 'Packaged CCX identity does not match the source plugin.' }
Write-Host "Premiere UXP development archive: $OutputPath"
Write-Host 'This ZIP is not installable and must never be renamed to .ccx. Use Adobe UXP Developer Tool > Package for a public release CCX.'
