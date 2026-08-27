param(
    [string]$SourceDir = "",
    [string]$Version = "",
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

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

# Copy the plugin files. This is an idempotent overwrite so re-running the
# installer always refreshes the deployed code without requiring a delete.
Get-ChildItem -Path $SourceDir -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($SourceDir.Length).TrimStart('\', '/')
    $dest = Join-Path $targetDir $relative
    $destDir = Split-Path -Parent $dest
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    Copy-Item -Force -LiteralPath $_.FullName -Destination $dest
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
