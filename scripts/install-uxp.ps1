param(
    [string]$SourceDir = "",
    [string]$Version = "",
    [switch]$AuditOnly,
    [switch]$NoDevMode,
    [switch]$RestartPremiere
)
# Deploy the UXP bridge plugin into Premiere Pro's UXP plugin folder so it
# loads without the UXP Developer Tool. UXP plugins under
# %APPDATA%\Adobe\UXP\Plugins\External\<id>_<version>\ are auto-discovered by
# Premiere when Adobe's UXP loader trusts the External path. We also seed the
# shared HMAC key + bridge-port settings so the panel can authenticate and
# discover the daemon port without any manual step.
#
# The plugin manifest id is com.codex.premiere-pro-full-mcp. A .ccx package is
# preferred (it renders as a single installable archive), but the installer
# also supports a raw source folder so it can be used before the .ccx exists.
#
# Parameters:
#   -SourceDir   Path to the plugin source (default: <repo>\uxp-plugin).
#   -Version     Override the manifest version (default: read manifest.json).
#   -NoDevMode   Do NOT write the UXP Developer "developer" flag.
#   -RestartPremiere  Attempt to close/reopen Premiere so the panel reloads.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $SourceDir) { $SourceDir = Join-Path $repoRoot "uxp-plugin" }

if (-not (Test-Path (Join-Path $SourceDir "manifest.json"))) {
    Write-Error "UXP plugin source not found at $SourceDir (missing manifest.json)."
    exit 1
}

# Resolve the version from the manifest unless the caller overrides it.
$manifest = Get-Content (Join-Path $SourceDir "manifest.json") -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $manifest.version }
if (-not $Version) {
    Write-Error "Could not determine the plugin version from manifest.json."
    exit 1
}

$pluginId = $manifest.id
if (-not $pluginId) {
    Write-Error "Could not determine the plugin id from manifest.json."
    exit 1
}

$uxpExternalRoot = Join-Path $env:APPDATA "Adobe\UXP\Plugins\External"
$targetDir = Join-Path $uxpExternalRoot "${pluginId}_${Version}"
$pluginDataRoot = Join-Path $env:APPDATA "Adobe\UXP\PluginsStorage\PPRO\26\External\$pluginId\PluginData"

Write-Host "== UXP bridge plugin =="
Write-Host "Source : $SourceDir"
Write-Host "Target : $targetDir"
Write-Host "Version: $Version"

if ($AuditOnly) {
    $sourceFiles = @(Get-ChildItem -LiteralPath $SourceDir -Recurse -File)
    if ($sourceFiles.Count -eq 0) { throw "UXP source contains no files: $SourceDir" }
    foreach ($required in @("manifest.json", "main.cjs", "auth.cjs", "api-catalog.cjs", "index.html")) {
        if (-not (Test-Path -LiteralPath (Join-Path $SourceDir $required) -PathType Leaf)) { throw "UXP source missing required file: $required" }
    }
    Write-Host "UXP installer preflight passed. No filesystem changes were made."
    return
}

New-Item -ItemType Directory -Force -Path $uxpExternalRoot | Out-Null
$quarantineRoot = Join-Path $env:LOCALAPPDATA "PremiereMCP\quarantine\uxp"
New-Item -ItemType Directory -Force -Path $quarantineRoot | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
$stageDir = Join-Path $uxpExternalRoot (".$pluginId.stage-" + [guid]::NewGuid().ToString("N"))
$backupDir = Join-Path $quarantineRoot ("${pluginId}_${Version}-backup-$stamp")
$hadCurrent = Test-Path -LiteralPath $targetDir -PathType Container
try {
    New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
    $sourceFiles = @(Get-ChildItem -LiteralPath $SourceDir -Recurse -File)
    foreach ($sourceFile in $sourceFiles) {
        $relative = $sourceFile.FullName.Substring($SourceDir.Length).TrimStart('\', '/')
        $dest = Join-Path $stageDir $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
        Copy-Item -Force -LiteralPath $sourceFile.FullName -Destination $dest
        $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash
        $destHash = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash
        if ($sourceHash -cne $destHash) { throw "UXP stage hash mismatch: $relative" }
    }
    if ($hadCurrent) { Move-Item -LiteralPath $targetDir -Destination $backupDir }
    Move-Item -LiteralPath $stageDir -Destination $targetDir
} catch {
    if (Test-Path -LiteralPath $targetDir -PathType Container) {
        $failedDir = Join-Path $quarantineRoot ("${pluginId}_${Version}-failed-$stamp")
        try { Move-Item -LiteralPath $targetDir -Destination $failedDir } catch { }
    }
    if ($hadCurrent -and (Test-Path -LiteralPath $backupDir -PathType Container) -and -not (Test-Path -LiteralPath $targetDir)) {
        Move-Item -LiteralPath $backupDir -Destination $targetDir
    }
    throw
} finally {
    if (Test-Path -LiteralPath $stageDir -PathType Container) {
        $stageFull = [System.IO.Path]::GetFullPath($stageDir)
        $externalFull = [System.IO.Path]::GetFullPath($uxpExternalRoot).TrimEnd('\')
        if (-not [string]::Equals((Split-Path -Parent $stageFull).TrimEnd('\'), $externalFull, [System.StringComparison]::OrdinalIgnoreCase) -or -not ([System.IO.Path]::GetFileName($stageFull).StartsWith(".$pluginId.stage-"))) {
            throw "Refusing to remove unexpected UXP stage path: $stageFull"
        }
        Remove-Item -LiteralPath $stageFull -Recurse -Force
    }
}

# Quarantine older versions of this exact plugin id after the new version is
# fully staged and swapped, so Premiere cannot choose an arbitrary duplicate.
Get-ChildItem -LiteralPath $uxpExternalRoot -Directory | Where-Object { $_.FullName -ne $targetDir } | ForEach-Object {
    $candidateManifest = Join-Path $_.FullName "manifest.json"
    if (-not (Test-Path -LiteralPath $candidateManifest)) { return }
    try { $candidate = Get-Content -LiteralPath $candidateManifest -Raw | ConvertFrom-Json } catch { return }
    if ($candidate.id -cne $pluginId) { return }
    $destination = Join-Path $quarantineRoot ($_.Name + "-superseded-$stamp")
    Move-Item -LiteralPath $_.FullName -Destination $destination
    Write-Host "Quarantined superseded UXP deployment: $destination"
}
if ($hadCurrent -and (Test-Path -LiteralPath $backupDir -PathType Container)) {
    Write-Host "Previous same-version UXP deployment retained for rollback: $backupDir"
}

# Seed the shared auth key + bridge-port settings so the panel can handshake
# with the daemon immediately. The key is 256-bit hex; the daemon reads the
# same file, so both sides converge on one secret without any config input.
New-Item -ItemType Directory -Force -Path $pluginDataRoot | Out-Null
$authPath = Join-Path $pluginDataRoot "premiere-mcp-bridge-key-v1"
if (-not (Test-Path $authPath)) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $secret = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    Set-Content -LiteralPath $authPath -Value "$secret`n" -Encoding Ascii -NoNewline
    Write-Host "Created UXP bridge auth key: $authPath"
} else {
    Write-Host "Retained existing UXP bridge auth key: $authPath"
}

$settingsPath = Join-Path $pluginDataRoot "bridge-settings-v1.json"
if (-not (Test-Path $settingsPath)) {
    Set-Content -LiteralPath $settingsPath -Value '{"schemaVersion":1,"port":17777}' -Encoding Ascii -NoNewline
    Write-Host "Created UXP bridge settings: $settingsPath"
} else {
    Write-Host "Retained existing UXP bridge settings: $settingsPath"
}

# UXP's External loader is toggle-gated by the developer flag in some builds.
# By default we keep the flag on (the safest path) unless the caller passes
# -NoDevMode. The flag is global to the UXP Developer tool and is harmless for
# production panels; keeping it set ensures the External plugin is discoverable
# even when Adobe has not yet shipped a standalone .ccx loader trust list.
if (-not $NoDevMode) {
    $devSettings = Join-Path $env:ProgramFiles "Common Files\Adobe\UXP\Developer\settings.json"
    $devParent = Split-Path -Parent $devSettings
    if (Test-Path $devParent) {
        $devJson = @{ developer = $true }
        if (Test-Path $devSettings) {
            try { $existing = Get-Content $devSettings -Raw | ConvertFrom-Json; if ($existing -is [hashtable]) { foreach ($k in $existing.Keys) { $devJson[$k] = $existing[$k] } } } catch { }
        }
        try {
            $devJson | ConvertTo-Json -Compress | Set-Content -LiteralPath $devSettings -Encoding Ascii -NoNewline
            Write-Host "Ensured UXP Developer flag is enabled (for External plugin discovery)."
        } catch {
            Write-Host "Could not update UXP Developer settings (admin may be required): $($_.Exception.Message)"
            Write-Host "If the panel does not appear, enable Development Mode once via the UXP Developer Tool."
        }
    } else {
        Write-Host "UXP Developer settings folder not found; External plugin discovery may require dev tool for this build."
    }
}

Write-Host ""
Write-Host "Deployed UXP bridge plugin to: $targetDir"
Write-Host "Open the panel via Window > Extensions > Premiere Pro Full MCP."
Write-Host "The panel auto-connects to the always-on daemon on 17777 without the UXP Developer Tool."

if ($RestartPremiere) {
    $proc = Get-Process -Name "premierepro" -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Host "Premiere Pro is running; the panel will appear after a restart. Please restart Premiere to load the new plugin."
    }
}
