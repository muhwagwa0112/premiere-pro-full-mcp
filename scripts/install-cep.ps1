param(
    [switch]$Force,
    [switch]$AuditOnly,
    [switch]$QuarantineKnownLegacyCep,
    [string]$CepSourceRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) "cep-plugin"),
    [string]$CepExtensionsRoot = (Join-Path $env:APPDATA "Adobe\CEP\extensions"),
    [string]$QuarantineRoot = (Join-Path $env:LOCALAPPDATA "PremiereMCP\quarantine\cep")
)
# Deploy the always-on bridge CEP extension into Premiere Pro's CEP folder.
# Overwrites the files that belong to this extension (index.html, main.ws.js,
# CSInterface.js, CSXS/manifest.xml). Old per-extension artifacts that are no
# longer part of the rebuilt extension (host.jsx, main.js, loader.jsx, ...)
# are removed so they cannot shadow the new bridge.

$ErrorActionPreference = "Stop"
$src = [System.IO.Path]::GetFullPath($CepSourceRoot)
$dstBase = [System.IO.Path]::GetFullPath($CepExtensionsRoot)
$dst = Join-Path $dstBase "com.codex.premiere-pro-full-mcp.cep"
$legacyBundleId = "com.local.ppmcp.cep.2026"
$currentBundleId = "com.codex.premiere-pro-full-mcp.cep"
$currentExtensionId = "com.codex.premiere-pro-full-mcp.cep.headless"
$requiredSourceFiles = @("index.html", "main.ws.js", "CSInterface.js", "CSXS\manifest.xml")

function Get-NormalizedPath([string]$Path) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
    # Path.TrimEndingDirectorySeparator is unavailable in Windows PowerShell
    # 5.1/.NET Framework. Preserve drive/UNC roots and trim both separator
    # forms only from non-root paths.
    if ([string]::Equals($fullPath, $pathRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $pathRoot
    }
    $separatorChars = [char[]]@(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    return $fullPath.TrimEnd($separatorChars)
}

function Test-PathEqual([string]$Left, [string]$Right) {
    return [string]::Equals(
        (Get-NormalizedPath $Left),
        (Get-NormalizedPath $Right),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Get-InstalledCepExtensions([string]$ExtensionsRoot) {
    if (-not (Test-Path -LiteralPath $ExtensionsRoot -PathType Container)) {
        return @()
    }

    $extensions = @()
    foreach ($directory in Get-ChildItem -LiteralPath $ExtensionsRoot -Directory -Force) {
        $manifestPath = Join-Path $directory.FullName "CSXS\manifest.xml"
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            continue
        }

        try {
            [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
        } catch {
            Write-Warning "Could not parse CEP manifest '$manifestPath'; leaving it untouched. $($_.Exception.Message)"
            continue
        }

        $bundleId = [string]$manifest.ExtensionManifest.ExtensionBundleId
        $extensions += [pscustomobject]@{
            BundleId = $bundleId
            Directory = $directory
            ManifestPath = $manifestPath
        }
    }
    return $extensions
}

function Test-KnownLegacyMoveSafety($Extension, [string]$ExtensionsRoot, [string]$DestinationRoot) {
    $normalizedRoot = Get-NormalizedPath $ExtensionsRoot
    $normalizedTarget = Get-NormalizedPath $Extension.Directory.FullName
    $targetParent = Split-Path -Parent $normalizedTarget
    if (-not (Test-PathEqual $targetParent $normalizedRoot)) {
        throw "[CEP_LEGACY_UNSAFE_PATH] Refusing to move '$normalizedTarget': it is not an immediate child of '$normalizedRoot'."
    }
    if (($Extension.Directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "[CEP_LEGACY_UNSAFE_PATH] Refusing to move reparse-point extension '$normalizedTarget'."
    }

    $normalizedQuarantineRoot = Get-NormalizedPath $DestinationRoot
    $rootPrefix = $normalizedRoot + [System.IO.Path]::DirectorySeparatorChar
    if ((Test-PathEqual $normalizedQuarantineRoot $normalizedRoot) -or
        $normalizedQuarantineRoot.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "[CEP_LEGACY_UNSAFE_QUARANTINE] Quarantine root must be outside the CEP discovery root: '$normalizedQuarantineRoot'."
    }
}

function Test-CurrentCepSource([string]$SourceRoot) {
    if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
        throw "[CEP_SOURCE_INCOMPLETE] Current CEP source directory not found: '$SourceRoot'."
    }

    foreach ($relativePath in $requiredSourceFiles) {
        $sourcePath = Join-Path $SourceRoot $relativePath
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "[CEP_SOURCE_INCOMPLETE] Required current CEP source file not found: '$sourcePath'."
        }
    }

    $manifestPath = Join-Path $SourceRoot "CSXS\manifest.xml"
    try {
        [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
    } catch {
        throw "[CEP_SOURCE_MANIFEST_INVALID] Could not parse current CEP manifest '$manifestPath': $($_.Exception.Message)"
    }
    $bundleId = [string]$manifest.ExtensionManifest.ExtensionBundleId
    $extensionIds = @($manifest.ExtensionManifest.ExtensionList.Extension | ForEach-Object { [string]$_.Id })
    if ($bundleId -cne $currentBundleId -or $extensionIds -cnotcontains $currentExtensionId) {
        throw "[CEP_SOURCE_IDENTITY_MISMATCH] Current CEP manifest identity is invalid. Expected bundle '$currentBundleId' and extension '$currentExtensionId'; observed bundle '$bundleId' and extensions '$($extensionIds -join ', ')'."
    }

    $hashes = @{}
    foreach ($relativePath in $requiredSourceFiles) {
        $hashes[$relativePath] = (Get-FileHash -LiteralPath (Join-Path $SourceRoot $relativePath) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $hashes
}

function Test-DeployedCep([string]$DestinationRoot, $ExpectedHashes) {
    foreach ($relativePath in $requiredSourceFiles) {
        $destinationPath = Join-Path $DestinationRoot $relativePath
        if (-not (Test-Path -LiteralPath $destinationPath -PathType Leaf)) {
            throw "[CEP_DEPLOYMENT_INCOMPLETE] Required deployed CEP file not found: '$destinationPath'."
        }
        $actualHash = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -cne $ExpectedHashes[$relativePath]) {
            throw "[CEP_DEPLOYMENT_HASH_MISMATCH] Deployed CEP file does not match source: '$destinationPath'."
        }
    }
}

function Move-KnownLegacyCepExtension($Extension, [string]$ExtensionsRoot, [string]$DestinationRoot) {
    Test-KnownLegacyMoveSafety $Extension $ExtensionsRoot $DestinationRoot

    $normalizedTarget = Get-NormalizedPath $Extension.Directory.FullName
    $normalizedQuarantineRoot = Get-NormalizedPath $DestinationRoot

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
    $quarantineDirectory = Join-Path $normalizedQuarantineRoot ($timestamp + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    $quarantinedExtension = Join-Path $quarantineDirectory $Extension.Directory.Name
    New-Item -ItemType Directory -Force -Path $quarantineDirectory | Out-Null
    if (Test-Path -LiteralPath $quarantinedExtension) {
        throw "[CEP_LEGACY_QUARANTINE_EXISTS] Quarantine destination already exists: '$quarantinedExtension'."
    }

    $quarantinedAt = (Get-Date).ToUniversalTime().ToString("o")
    $manifestSha256 = (Get-FileHash -LiteralPath $Extension.ManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Move-Item -LiteralPath $normalizedTarget -Destination $quarantinedExtension

    $record = [ordered]@{
        originalPath = $normalizedTarget
        quarantinedPath = $quarantinedExtension
        bundleId = $Extension.BundleId
        quarantinedAtUtc = $quarantinedAt
        manifestSha256 = $manifestSha256
    }
    try {
        $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $quarantineDirectory "quarantine.json") -Encoding UTF8
    } catch {
        # Do not leave an unrecorded quarantine move. Restore the extension when
        # writing its recovery metadata fails, then surface the original error.
        if ((Test-Path -LiteralPath $quarantinedExtension) -and -not (Test-Path -LiteralPath $normalizedTarget)) {
            Move-Item -LiteralPath $quarantinedExtension -Destination $normalizedTarget
        }
        throw
    }
    Write-Host "Quarantined known legacy CEP extension: $normalizedTarget"
    Write-Host "Reversible quarantine location: $quarantinedExtension"
    Write-Host "Restore record: $(Join-Path $quarantineDirectory 'quarantine.json')"
}

# Validate the replacement before making any deployment or quarantine change.
$sourceHashes = Test-CurrentCepSource $src

# Audit every immediate child by its manifest bundle ID. Folder names and broad
# naming patterns are intentionally not used to identify legacy extensions.
$installedExtensions = @(Get-InstalledCepExtensions $dstBase)
$legacyExtensions = @($installedExtensions | Where-Object { $_.BundleId -ceq $legacyBundleId })
if ($legacyExtensions.Count -gt 0) {
    if (-not $QuarantineKnownLegacyCep) {
        $paths = ($legacyExtensions | ForEach-Object { $_.Directory.FullName }) -join ", "
        throw "[CEP_LEGACY_CONFLICT] Known legacy CEP bundle '$legacyBundleId' is installed at: $paths. Re-run with -QuarantineKnownLegacyCep to move only the verified legacy extension into reversible quarantine, then restart Premiere Pro."
    }
    foreach ($legacy in $legacyExtensions) {
        Test-KnownLegacyMoveSafety $legacy $dstBase $QuarantineRoot
    }
}

if ($AuditOnly) {
    Write-Host "CEP installer preflight passed. No filesystem changes were made."
    return
}

New-Item -ItemType Directory -Force -Path $dstBase | Out-Null
New-Item -ItemType Directory -Force -Path $QuarantineRoot | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
$stage = Join-Path $dstBase (".com.codex.premiere-pro-full-mcp.cep.stage-" + [guid]::NewGuid().ToString("N"))
$backup = Join-Path $QuarantineRoot ("current-backup-$stamp-" + [guid]::NewGuid().ToString("N"))
$failed = Join-Path $QuarantineRoot ("failed-deployment-$stamp-" + [guid]::NewGuid().ToString("N"))
$hadCurrent = Test-Path -LiteralPath $dst -PathType Container
try {
    New-Item -ItemType Directory -Force -Path (Join-Path $stage "CSXS") | Out-Null
    Copy-Item -Force (Join-Path $src "index.html") $stage
    Copy-Item -Force (Join-Path $src "main.ws.js") $stage
    Copy-Item -Force (Join-Path $src "CSInterface.js") $stage
    Copy-Item -Force (Join-Path $src "CSXS\manifest.xml") (Join-Path $stage "CSXS\manifest.xml")
    Test-DeployedCep $stage $sourceHashes

    if ($hadCurrent) { Move-Item -LiteralPath $dst -Destination $backup }
    Move-Item -LiteralPath $stage -Destination $dst
    Test-DeployedCep $dst $sourceHashes
} catch {
    if (Test-Path -LiteralPath $dst -PathType Container) {
        try { Move-Item -LiteralPath $dst -Destination $failed } catch { }
    }
    if ($hadCurrent -and (Test-Path -LiteralPath $backup -PathType Container) -and -not (Test-Path -LiteralPath $dst)) {
        Move-Item -LiteralPath $backup -Destination $dst
    }
    throw
} finally {
    if (Test-Path -LiteralPath $stage -PathType Container) {
        $stageFull = [System.IO.Path]::GetFullPath($stage)
        if (-not (Test-PathEqual (Split-Path -Parent $stageFull) $dstBase) -or -not ([System.IO.Path]::GetFileName($stageFull).StartsWith(".com.codex.premiere-pro-full-mcp.cep.stage-"))) {
            throw "[CEP_STAGE_UNSAFE_PATH] Refusing to remove unexpected stage '$stageFull'."
        }
        Remove-Item -LiteralPath $stageFull -Recurse -Force
    }
}

if ($hadCurrent -and (Test-Path -LiteralPath $backup -PathType Container)) {
    @{ schemaVersion = 1; kind = "current-backup"; originalPath = $dst; backupPath = $backup; deployedAt = (Get-Date).ToUniversalTime().ToString("o") } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup "quarantine.json") -Encoding UTF8
    Write-Host "Previous CEP deployment retained for rollback at: $backup"
}

# Quarantine only after current deployment and cleanup have both succeeded.
foreach ($legacy in $legacyExtensions) {
    Move-KnownLegacyCepExtension $legacy $dstBase $QuarantineRoot
}

Write-Host "Deployed rebuilt CEP extension to: $dst"
Write-Host "Restart Premiere Pro to load the new bridge."
