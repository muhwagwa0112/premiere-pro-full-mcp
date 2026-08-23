[CmdletBinding()]
param(
    [switch]$RemoveCodexMcp,
    [switch]$KeepUdtWorkspaceRegistration,
    [string]$McpName = "premiere_pro_2026_local"
)

$ErrorActionPreference = "Stop"
$PackageRoot = Split-Path -Parent $PSCommandPath
$Metadata = Get-Content -LiteralPath (Join-Path $PackageRoot "RELEASE-METADATA.json") -Raw | ConvertFrom-Json
$LocalBase = Join-Path $env:LOCALAPPDATA "PremiereMCP"
$ArchiveBase = Join-Path $LocalBase ("backups\uninstall-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$UxpManifest = Join-Path $LocalBase ("uxp-plugin-" + $Metadata.version + "\manifest.json")
$Targets = @(
    @{ Path = (Join-Path $LocalBase "bin"); Name = "bin" },
    @{ Path = (Join-Path $LocalBase "bundle"); Name = "bundle" },
    @{ Path = (Join-Path $LocalBase "generated"); Name = "generated" },
    @{ Path = (Join-Path $LocalBase ("uxp-plugin-" + $Metadata.version)); Name = ("uxp-plugin-" + $Metadata.version) },
    @{ Path = (Join-Path $env:APPDATA "Adobe\CEP\extensions\com.local.ppmcp.cep.2026"); Name = "cep-extension" }
)

function Assert-UserProfileTarget([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $roots = @([IO.Path]::GetFullPath($env:LOCALAPPDATA), [IO.Path]::GetFullPath($env:APPDATA))
    if (-not ($roots | Where-Object { $resolved.StartsWith($_ + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) })) {
        throw "Refusing path outside the current user profile: $resolved"
    }
}

if (-not $KeepUdtWorkspaceRegistration) {
    $UdtRegistrationScript = Join-Path $PackageRoot "source\scripts\register-udt-workspace.mjs"
    $Node = Get-Command node -ErrorAction SilentlyContinue
    if ($Node -and (Test-Path -LiteralPath $UdtRegistrationScript)) {
        & $Node.Source $UdtRegistrationScript --manifest $UxpManifest --remove
        if ($LASTEXITCODE -ne 0) { Write-Warning "Could not remove the UDT workspace entry; other uninstall steps will continue." }
    } else {
        Write-Warning "Node or the UDT registration helper is unavailable. Remove the stale UDT manifest entry manually if present: $UxpManifest"
    }
}

foreach ($item in $Targets) {
    Assert-UserProfileTarget $item.Path
    if (Test-Path -LiteralPath $item.Path) {
        New-Item -ItemType Directory -Path $ArchiveBase -Force | Out-Null
        Move-Item -LiteralPath $item.Path -Destination (Join-Path $ArchiveBase $item.Name)
    }
}

if ($RemoveCodexMcp) {
    if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { throw "codex is not available on PATH." }
    & codex mcp remove $McpName
    if ($LASTEXITCODE -ne 0) { throw "Codex MCP removal failed for '$McpName'." }
}

Write-Host "Premiere MCP runtime files were moved out of active locations."
if (Test-Path -LiteralPath $ArchiveBase) { Write-Host "Recoverable uninstall archive: $ArchiveBase" }
if (-not $RemoveCodexMcp) { Write-Host "Codex registration was not changed. Use -RemoveCodexMcp to remove it." }
