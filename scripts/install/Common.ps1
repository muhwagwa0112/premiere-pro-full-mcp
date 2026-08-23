Set-StrictMode -Version 2.0

$script:PpMcpProduct = 'premiere-pro-full-mcp'
$script:PpMcpRepository = 'muhwagwa0112/premiere-pro-full-mcp'
$script:PpMcpRegistration = 'premiere_pro_full_mcp'
$script:PpMcpPluginId = 'com.codex.premiere-pro-full-mcp'

function Get-PpMcpInstallRoot {
    param([string]$InstallRoot)
    if ($InstallRoot) { return [System.IO.Path]::GetFullPath($InstallRoot) }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable. Pass -InstallRoot explicitly.' }
    return Join-Path $env:LOCALAPPDATA 'PremiereMCP'
}

function Get-PpMcpCepInstallRoot {
    param([string]$CepInstallRoot)
    if ($CepInstallRoot) { return [System.IO.Path]::GetFullPath($CepInstallRoot) }
    if (-not $env:APPDATA) { throw 'APPDATA is unavailable. Pass -CepInstallRoot explicitly.' }
    return Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.codex.premiere-pro-full-mcp.cep'
}

function Invoke-PpMcpCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$FailureMessage = 'External command failed'
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$FailureMessage (exit $LASTEXITCODE)" }
}

function Get-PpMcpSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $resolved = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "File not found: $resolved" }
    return (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-PpMcpReleasePublicKeyPath {
    param([string]$PublicKeyPath)
    $path = if ($PublicKeyPath) { $PublicKeyPath } else { Join-Path $PSScriptRoot 'release-signing-public.xml' }
    $resolved = [System.IO.Path]::GetFullPath($path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "Release signing public key is missing: $resolved" }
    return $resolved
}

function Assert-PpMcpReleaseSigningKey {
    param(
        [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
        [string]$PublicKeyPath
    )
    $resolvedPrivate = [System.IO.Path]::GetFullPath($PrivateKeyPath)
    $resolvedPublic = Get-PpMcpReleasePublicKeyPath -PublicKeyPath $PublicKeyPath
    if (-not (Test-Path -LiteralPath $resolvedPrivate -PathType Leaf)) { throw "Release signing private key is missing: $resolvedPrivate" }
    $privateRsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider 3072
    $publicRsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    try {
        $privateRsa.FromXmlString([System.IO.File]::ReadAllText($resolvedPrivate))
        $publicRsa.FromXmlString([System.IO.File]::ReadAllText($resolvedPublic))
        if ($privateRsa.PublicOnly) { throw 'Release signing key does not contain a private key.' }
        $probe = [System.Text.Encoding]::UTF8.GetBytes('premiere-pro-full-mcp release-key preflight v1')
        $signature = $privateRsa.SignData($probe, [System.Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'))
        if (-not $publicRsa.VerifyData($probe, [System.Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'), $signature)) {
            throw 'Release signing private key does not match the committed public key.'
        }
    } finally {
        $privateRsa.Dispose()
        $publicRsa.Dispose()
    }
}

function Write-PpMcpReleaseSignature {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$SignaturePath,
        [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
        [string]$PublicKeyPath
    )
    Write-PpMcpDetachedSignature -InputPath $ManifestPath -SignaturePath $SignaturePath -PrivateKeyPath $PrivateKeyPath
    $resolvedManifest = [System.IO.Path]::GetFullPath($ManifestPath)
    $null = Read-PpMcpSignedReleaseManifest -ManifestPath $resolvedManifest -SignaturePath $SignaturePath -PublicKeyPath $PublicKeyPath
}

function Write-PpMcpDetachedSignature {
    param(
        [Parameter(Mandatory = $true)][string]$InputPath,
        [Parameter(Mandatory = $true)][string]$SignaturePath,
        [Parameter(Mandatory = $true)][string]$PrivateKeyPath
    )
    $resolvedInput = [System.IO.Path]::GetFullPath($InputPath)
    $resolvedPrivate = [System.IO.Path]::GetFullPath($PrivateKeyPath)
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider 3072
    try {
        $rsa.FromXmlString([System.IO.File]::ReadAllText($resolvedPrivate))
        if ($rsa.PublicOnly) { throw 'Release signing key does not contain a private key.' }
        $signature = $rsa.SignData([System.IO.File]::ReadAllBytes($resolvedInput), [System.Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'))
        [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($SignaturePath), [Convert]::ToBase64String($signature) + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    } finally {
        $rsa.Dispose()
    }
}

function Assert-PpMcpDetachedSignature {
    param(
        [Parameter(Mandatory = $true)][string]$InputPath,
        [Parameter(Mandatory = $true)][string]$SignaturePath,
        [string]$PublicKeyPath
    )
    $resolvedInput = [System.IO.Path]::GetFullPath($InputPath)
    $resolvedSignature = [System.IO.Path]::GetFullPath($SignaturePath)
    $resolvedPublic = Get-PpMcpReleasePublicKeyPath -PublicKeyPath $PublicKeyPath
    try { $signature = [Convert]::FromBase64String(([System.IO.File]::ReadAllText($resolvedSignature)).Trim()) }
    catch { throw 'Detached signature is not valid base64.' }
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    try {
        $rsa.FromXmlString([System.IO.File]::ReadAllText($resolvedPublic))
        $valid = $rsa.VerifyData([System.IO.File]::ReadAllBytes($resolvedInput), [System.Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'), $signature)
    } finally { $rsa.Dispose() }
    if (-not $valid) { throw 'Detached signature verification failed.' }
}

function Read-PpMcpSignedReleaseManifest {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$SignaturePath,
        [string]$PublicKeyPath,
        [string]$ExpectedRepository,
        [string]$ExpectedTag
    )
    $resolvedManifest = [System.IO.Path]::GetFullPath($ManifestPath)
    $resolvedSignature = [System.IO.Path]::GetFullPath($SignaturePath)
    $resolvedPublic = Get-PpMcpReleasePublicKeyPath -PublicKeyPath $PublicKeyPath
    foreach ($required in @($resolvedManifest, $resolvedSignature)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Signed release metadata is missing: $required" }
    }
    try { $signature = [Convert]::FromBase64String(([System.IO.File]::ReadAllText($resolvedSignature)).Trim()) }
    catch { throw 'Release signature is not valid base64.' }
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    try {
        $rsa.FromXmlString([System.IO.File]::ReadAllText($resolvedPublic))
        $valid = $rsa.VerifyData([System.IO.File]::ReadAllBytes($resolvedManifest), [System.Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'), $signature)
    } finally { $rsa.Dispose() }
    if (-not $valid) { throw 'Release manifest signature verification failed.' }
    try { $manifest = Get-Content -LiteralPath $resolvedManifest -Raw | ConvertFrom-Json }
    catch { throw 'Release manifest is not valid JSON.' }
    $keyId = Get-PpMcpSha256 -Path $resolvedPublic
    if ($manifest.schema -ne 'premiere-pro-full-mcp-release/1' -or $manifest.product -ne $script:PpMcpProduct) { throw 'Release manifest schema or product is invalid.' }
    if ($manifest.signatureAlgorithm -ne 'rsa-sha256-pkcs1' -or $manifest.keyId -ne $keyId) { throw 'Release manifest signing identity is invalid.' }
    if ($ExpectedRepository -and $manifest.repository -ne $ExpectedRepository) { throw 'Release manifest repository does not match the configured repository.' }
    if ($ExpectedTag -and $manifest.tag -ne $ExpectedTag) { throw 'Release manifest tag does not match the selected release.' }
    if (-not $manifest.version -or $manifest.version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$' -or $manifest.tag -ne "v$($manifest.version)") { throw 'Release manifest version or tag is invalid.' }
    if ($manifest.platform -ne 'windows' -or $manifest.architecture -ne 'win-x64') { throw 'Release manifest platform is invalid.' }
    $zip = $manifest.assets.windowsZip
    if (-not $zip -or $zip.name -ne "premiere-pro-full-mcp-v$($manifest.version)-windows.zip" -or $zip.sha256 -notmatch '^[a-f0-9]{64}$' -or [long]$zip.size -le 0) { throw 'Release manifest ZIP binding is invalid.' }
    $ccx = $manifest.assets.ccx
    if (-not $ccx -or $ccx.name -ne "premiere-pro-full-mcp-v$($manifest.version).ccx" -or $ccx.sha256 -notmatch '^[a-f0-9]{64}$' -or [long]$ccx.size -le 0 -or $ccx.pluginId -ne $script:PpMcpPluginId -or $ccx.pluginVersion -ne $manifest.version) { throw 'Release manifest CCX binding is invalid.' }
    $sbom = $manifest.assets.sbom
    if (-not $sbom -or $sbom.name -ne "premiere-pro-full-mcp-v$($manifest.version).spdx.json" -or $sbom.sha256 -notmatch '^[a-f0-9]{64}$' -or [long]$sbom.size -le 0) { throw 'Release manifest SBOM binding is invalid.' }
    $notices = $manifest.assets.thirdPartyNotices
    if (-not $notices -or $notices.name -ne "premiere-pro-full-mcp-v$($manifest.version)-third-party-notices.txt" -or $notices.sha256 -notmatch '^[a-f0-9]{64}$' -or [long]$notices.size -le 0) { throw 'Release manifest third-party-notices binding is invalid.' }
    return $manifest
}

function Write-PpMcpJsonAtomic {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporary = "$Path.$PID.tmp"
    [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 10) + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-PpMcpCurrentMetadata {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)
    $path = Join-Path $InstallRoot 'app\current.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

function Expand-PpMcpSafeArchive {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Path]::GetFullPath($ArchivePath)
    $destination = [System.IO.Path]::GetFullPath($DestinationPath)
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw "Archive not found: $archive" }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $destinationPrefix = $destination.TrimEnd('\') + [System.IO.Path]::DirectorySeparatorChar
    $seen = @{}
    $totalBytes = [long]0
    $stream = [System.IO.File]::OpenRead($archive)
    try {
        $zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Read, $false)
        try {
            if ($zip.Entries.Count -gt 10000) { throw 'Archive contains too many entries.' }
            foreach ($entry in $zip.Entries) {
                $name = [string]$entry.FullName
                if (-not $name -or $name.IndexOf([char]0) -ge 0 -or $name -match '^[\\/]' -or $name.Contains(':')) { throw "Unsafe archive entry: $name" }
                $segments = @(@($name -split '[\\/]') | Where-Object { $_ -ne '' })
                if (-not $segments.Count -or ($segments | Where-Object { $_ -in @('.', '..') -or $_ -match '[\. ]$' }).Count) { throw "Unsafe archive path segment: $name" }
                $canonical = ($segments -join '/').ToLowerInvariant()
                if ($seen.ContainsKey($canonical)) { throw "Duplicate or case-colliding archive entry: $name" }
                $seen[$canonical] = $true
                $target = [System.IO.Path]::GetFullPath((Join-Path $destination ($segments -join [System.IO.Path]::DirectorySeparatorChar)))
                if (-not $target.StartsWith($destinationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Archive entry escapes the destination: $name" }
                $unixMode = ([uint32]$entry.ExternalAttributes -shr 16) -band 0xF000
                $windowsAttributes = [uint32]$entry.ExternalAttributes -band 0xFFFF
                if ($unixMode -eq 0xA000 -or ($windowsAttributes -band [uint32][System.IO.FileAttributes]::ReparsePoint)) { throw "Links and reparse points are not allowed in archives: $name" }
                $totalBytes += [long]$entry.Length
                if ($entry.Length -gt 1GB -or $totalBytes -gt 2GB -or ($entry.CompressedLength -gt 0 -and $entry.Length / $entry.CompressedLength -gt 5000)) { throw "Archive expansion limits exceeded: $name" }
            }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
    [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $destination)
}

function Get-PpMcpCodexConfigPath {
    if ($env:CODEX_HOME) { return Join-Path $env:CODEX_HOME 'config.toml' }
    if (-not $env:USERPROFILE) { return $null }
    return Join-Path $env:USERPROFILE '.codex\config.toml'
}

function Set-PpMcpCodexRegistration {
    param(
        [Parameter(Mandatory = $true)][string]$Launcher,
        [Parameter(Mandatory = $true)][string]$Bundle,
        [Parameter(Mandatory = $true)][string]$InstallRoot
    )
    if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { throw 'Codex CLI was not found on PATH.' }
    $configPath = Get-PpMcpCodexConfigPath
    $backup = if ($configPath) { $configPath + ('.premiere-mcp-backup-{0}' -f [Guid]::NewGuid().ToString('N')) } else { Join-Path $InstallRoot ('.registration-backup-{0}.toml' -f [Guid]::NewGuid().ToString('N')) }
    $hadConfig = $false
    if ($configPath -and (Test-Path -LiteralPath $configPath -PathType Leaf)) { Copy-Item -LiteralPath $configPath -Destination $backup -Force; $hadConfig = $true }
    try {
        $null = & codex mcp get $script:PpMcpRegistration 2>$null
        if ($LASTEXITCODE -eq 0) { Invoke-PpMcpCommand -FilePath 'codex' -Arguments @('mcp', 'remove', $script:PpMcpRegistration) -FailureMessage 'Could not replace the existing Premiere MCP registration' }
        Invoke-PpMcpCommand -FilePath 'codex' -Arguments @('mcp', 'add', $script:PpMcpRegistration, '--', $Launcher, '--launch-mcp', $Bundle) -FailureMessage 'Codex MCP registration failed'
    } catch {
        if ($configPath) {
            if ($hadConfig) { Copy-Item -LiteralPath $backup -Destination $configPath -Force }
            elseif (Test-Path -LiteralPath $configPath) { Remove-Item -LiteralPath $configPath -Force }
        }
        throw
    } finally { if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force } }
}

function Assert-PpMcpSafeRemovalRoot {
    param([Parameter(Mandatory = $true)][string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $root = [System.IO.Path]::GetPathRoot($full).TrimEnd('\')
    if (-not $full -or $full -eq $root -or $full -eq $env:USERPROFILE -or $full -eq $env:LOCALAPPDATA -or $full -eq $env:APPDATA) { throw "Refusing unsafe removal target: $full" }
    return $full
}
