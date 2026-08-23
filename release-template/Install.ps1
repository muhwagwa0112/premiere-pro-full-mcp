[CmdletBinding()]
param(
    [switch]$RegisterCodexMcp,
    [switch]$SkipUdtWorkspaceRegistration,
    [string]$McpName = "premiere_pro_2026_local"
)

$ErrorActionPreference = "Stop"
$PackageRoot = Split-Path -Parent $PSCommandPath
$Metadata = Get-Content -LiteralPath (Join-Path $PackageRoot "RELEASE-METADATA.json") -Raw | ConvertFrom-Json
$LocalBase = Join-Path $env:LOCALAPPDATA "PremiereMCP"
$BackupBase = Join-Path $LocalBase ("backups\install-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$CepTarget = Join-Path $env:APPDATA "Adobe\CEP\extensions\com.local.ppmcp.cep.2026"
$UxpTarget = Join-Path $LocalBase ("uxp-plugin-" + $Metadata.version)
$BundleTarget = Join-Path $LocalBase "bundle"
$GeneratedTarget = Join-Path $LocalBase "generated"
$NativeTarget = Join-Path $LocalBase "bin"
$WorkspaceTarget = Join-Path $LocalBase "workspace"

function Assert-UserProfileTarget([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $roots = @([IO.Path]::GetFullPath($env:LOCALAPPDATA), [IO.Path]::GetFullPath($env:APPDATA))
    if (-not ($roots | Where-Object { $resolved.StartsWith($_ + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) })) {
        throw "Refusing path outside the current user profile: $resolved"
    }
}

function Backup-And-Copy([string]$Source, [string]$Target, [string]$BackupName) {
    Assert-UserProfileTarget $Target
    if (Test-Path -LiteralPath $Target) {
        New-Item -ItemType Directory -Path $BackupBase -Force | Out-Null
        Move-Item -LiteralPath $Target -Destination (Join-Path $BackupBase $BackupName)
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Target -Recurse -Force
}

$ManifestPath = Join-Path $PackageRoot "MANIFEST.sha256"
Get-Content -LiteralPath $ManifestPath | ForEach-Object {
    if ($_ -notmatch '^([0-9a-f]{64}) \*(.+)$') { throw "Invalid MANIFEST.sha256 entry: $_" }
    $expected = $Matches[1]
    $relative = $Matches[2].Replace('/', [IO.Path]::DirectorySeparatorChar)
    $candidate = [IO.Path]::GetFullPath((Join-Path $PackageRoot $relative))
    if (-not $candidate.StartsWith([IO.Path]::GetFullPath($PackageRoot) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Manifest path escapes the package: $relative"
    }
    $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "Package integrity check failed: $relative" }
}

Backup-And-Copy (Join-Path $PackageRoot "native\win-x64") $NativeTarget "bin"
Backup-And-Copy (Join-Path $PackageRoot "bundle") $BundleTarget "bundle"
Backup-And-Copy (Join-Path $PackageRoot "generated") $GeneratedTarget "generated"
Backup-And-Copy (Join-Path $PackageRoot "uxp-plugin") $UxpTarget ("uxp-plugin-" + $Metadata.version)
Backup-And-Copy (Join-Path $PackageRoot "cep-plugin") $CepTarget "cep-extension"
New-Item -ItemType Directory -Path $WorkspaceTarget -Force | Out-Null

$Launcher = Join-Path $NativeTarget "PremiereMcp.WindowsUiAgent.exe"
$Bundle = Join-Path $BundleTarget "premiere-mcp.bundle.mjs"
$UxpManifest = Join-Path $UxpTarget "manifest.json"

& $Launcher --provision-uxp $UxpTarget
if ($LASTEXITCODE -ne 0) { throw "Native UXP bootstrap provisioning failed with exit code $LASTEXITCODE." }

if (-not $SkipUdtWorkspaceRegistration) {
    $UdtRegistrationScript = Join-Path $PackageRoot "source\scripts\register-udt-workspace.mjs"
    $Node = Get-Command node -ErrorAction SilentlyContinue
    if ($Node -and (Test-Path -LiteralPath $UdtRegistrationScript)) {
        & $Node.Source $UdtRegistrationScript --manifest $UxpManifest
        if ($LASTEXITCODE -ne 0) { throw "Adobe UXP Developer Tool workspace registration failed with exit code $LASTEXITCODE." }
    } else {
        Write-Warning "Node or the UDT registration helper is unavailable; the core runtime is installed, but UDT registration was skipped. Add this manifest manually: $UxpManifest"
    }
}

if ($RegisterCodexMcp) {
    if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { throw "codex is not available on PATH." }
    & codex mcp add $McpName -- $Launcher --launch-mcp $Bundle
    if ($LASTEXITCODE -ne 0) { throw "Codex MCP registration failed. Remove or rename an existing '$McpName' registration, then retry." }
}

Write-Host "Installed Premiere MCP $($Metadata.version) for the current Windows user."
if (Test-Path -LiteralPath $BackupBase) { Write-Host "Previous files were backed up to: $BackupBase" }
Write-Host "UXP manifest: $UxpManifest"
Write-Host "Approve a pending R2/R3 operation directly with: & '$Launcher' --approval approve <approval-id>"
if (-not $RegisterCodexMcp) {
    Write-Host "Codex registration was not changed. To register, rerun: .\Install.ps1 -RegisterCodexMcp"
}
