[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [string]$CepInstallRoot = '',
    [string]$PackagePath = '',
    [string]$ManifestPath = '',
    [string]$SignaturePath = '',
    [string]$Repository = 'muhwagwa0112/premiere-pro-full-mcp',
    [switch]$SkipCodexRegistration,
    [switch]$SkipCcxLaunch,
    [switch]$AllowSameVersion
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
if ($Repository -ne $script:PpMcpRepository) { throw 'The updater repository is pinned and cannot be overridden.' }
$resolvedInstallRoot = Get-PpMcpInstallRoot -InstallRoot $InstallRoot
$resolvedCepRoot = Get-PpMcpCepInstallRoot -CepInstallRoot $CepInstallRoot
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('premiere-mcp-update-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
try {
    $package = $PackagePath
    if (-not $package) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers @{ 'User-Agent' = 'Premiere-Pro-Full-MCP-Updater'; 'Accept' = 'application/vnd.github+json' }
        if ($release.draft -or $release.prerelease) { throw 'Draft and prerelease updates are rejected.' }
        $manifests = @($release.assets | Where-Object { $_.name -match '^premiere-pro-full-mcp-v.+-windows\.zip\.manifest\.json$' })
        if ($manifests.Count -ne 1) { throw 'The latest release must contain exactly one signed Windows manifest.' }
        $signatures = @($release.assets | Where-Object { $_.name -eq ($manifests[0].name + '.sig') })
        if ($signatures.Count -ne 1) { throw 'The latest release must contain exactly one matching manifest signature.' }
        $ManifestPath = Join-Path $temporaryRoot $manifests[0].name
        $SignaturePath = "$ManifestPath.sig"
        Invoke-WebRequest -Uri $manifests[0].browser_download_url -OutFile $ManifestPath -UseBasicParsing
        Invoke-WebRequest -Uri $signatures[0].browser_download_url -OutFile $SignaturePath -UseBasicParsing
        $signed = Read-PpMcpSignedReleaseManifest -ManifestPath $ManifestPath -SignaturePath $SignaturePath -ExpectedRepository $Repository -ExpectedTag ([string]$release.tag_name)
        $packages = @($release.assets | Where-Object { $_.name -eq $signed.assets.windowsZip.name })
        if ($packages.Count -ne 1) { throw 'The signed release ZIP asset is missing or ambiguous.' }
        $package = Join-Path $temporaryRoot $signed.assets.windowsZip.name
        Invoke-WebRequest -Uri $packages[0].browser_download_url -OutFile $package -UseBasicParsing
    } else {
        $package = [System.IO.Path]::GetFullPath($package)
        if (-not $ManifestPath) { $ManifestPath = "$package.manifest.json" }
        if (-not $SignaturePath) { $SignaturePath = "$ManifestPath.sig" }
        $signed = Read-PpMcpSignedReleaseManifest -ManifestPath $ManifestPath -SignaturePath $SignaturePath -ExpectedRepository $Repository
    }

    $current = Get-PpMcpCurrentMetadata -InstallRoot $resolvedInstallRoot
    if ($current) {
        $currentVersion = [version]([string]$current.version)
        $nextVersion = [version]([string]$signed.version)
        if ($nextVersion -lt $currentVersion -or ($nextVersion -eq $currentVersion -and -not $AllowSameVersion)) { throw "Update version $nextVersion is not newer than installed version $currentVersion." }
    }
    if ([System.IO.Path]::GetFileName($package) -ne [string]$signed.assets.windowsZip.name) { throw 'Signed manifest ZIP name mismatch.' }
    if ((Get-Item -LiteralPath $package).Length -ne [long]$signed.assets.windowsZip.size -or (Get-PpMcpSha256 -Path $package) -ne [string]$signed.assets.windowsZip.sha256) { throw 'Signed update ZIP verification failed.' }
    $expanded = Join-Path $temporaryRoot 'expanded'
    Expand-PpMcpSafeArchive -ArchivePath $package -DestinationPath $expanded
    $top = @(Get-ChildItem -LiteralPath $expanded -Force)
    if ($top.Count -ne 1 -or -not $top[0].PSIsContainer -or $top[0].Name -ne "premiere-pro-full-mcp-$($signed.version)") { throw 'Authenticated archive layout is invalid.' }
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $top[0].FullName 'Install.ps1'), '-InstallRoot', $resolvedInstallRoot, '-CepInstallRoot', $resolvedCepRoot, '-PackagePath', $top[0].FullName)
    if ($SkipCodexRegistration) { $arguments += '-SkipCodexRegistration' }
    if ($SkipCcxLaunch) { $arguments += '-SkipCcxLaunch' }
    Invoke-PpMcpCommand -FilePath 'powershell.exe' -Arguments $arguments -FailureMessage 'Update installation failed'
} finally { if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force } }
