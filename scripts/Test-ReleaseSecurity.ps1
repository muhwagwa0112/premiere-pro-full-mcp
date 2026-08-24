[CmdletBinding()]
param(
    [string]$ArchivePath = '',
    [string]$ManifestPath = '',
    [string]$SignaturePath = '',
    [string]$PrivateKeyPath = '',
    [switch]$RequireReleaseArtifacts
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $repoRoot 'scripts\install\Common.ps1')
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('premiere-mcp-security-test-' + [Guid]::NewGuid().ToString('N'))
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if (-not ([System.IO.Path]::GetFullPath($temporaryRoot)).StartsWith($temporaryBase, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test temp path.' }
try {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
    $malicious = Join-Path $temporaryRoot 'traversal.zip'
    $stream = [System.IO.File]::Create($malicious)
    try {
        $zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
        try {
            $entry = $zip.CreateEntry('../escaped.txt')
            $writer = New-Object System.IO.StreamWriter($entry.Open())
            try { $writer.Write('must not escape') } finally { $writer.Dispose() }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
    $rejected = $false
    try { Expand-PpMcpSafeArchive -ArchivePath $malicious -DestinationPath (Join-Path $temporaryRoot 'expanded') }
    catch { $rejected = $true }
    if (-not $rejected -or (Test-Path -LiteralPath (Join-Path $temporaryRoot 'escaped.txt'))) { throw 'ZIP traversal was not rejected before extraction.' }

    $udtCompatible = Join-Path $temporaryRoot 'udt-compatible.zip'
    $stream = [System.IO.File]::Create($udtCompatible)
    try {
        $zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
        try {
            $entry = $zip.CreateEntry('manifest.json')
            $entry.ExternalAttributes = [System.BitConverter]::ToInt32([System.BitConverter]::GetBytes([uint32]2175008768), 0)
            $writer = New-Object System.IO.StreamWriter($entry.Open())
            try { $writer.Write('{}') } finally { $writer.Dispose() }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
    Expand-PpMcpSafeArchive -ArchivePath $udtCompatible -DestinationPath (Join-Path $temporaryRoot 'udt-expanded')
    if (-not (Test-Path -LiteralPath (Join-Path $temporaryRoot 'udt-expanded\manifest.json') -PathType Leaf)) { throw 'A valid UDT-style signed ExternalAttributes value was rejected.' }

    $symlinkArchive = Join-Path $temporaryRoot 'symlink.zip'
    $stream = [System.IO.File]::Create($symlinkArchive)
    try {
        $zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
        try {
            $entry = $zip.CreateEntry('link')
            $entry.ExternalAttributes = [System.BitConverter]::ToInt32([System.BitConverter]::GetBytes([uint32]2717843456), 0)
            $writer = New-Object System.IO.StreamWriter($entry.Open())
            try { $writer.Write('target') } finally { $writer.Dispose() }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
    $symlinkRejected = $false
    try { Expand-PpMcpSafeArchive -ArchivePath $symlinkArchive -DestinationPath (Join-Path $temporaryRoot 'symlink-expanded') }
    catch { $symlinkRejected = $_.Exception.Message -match 'Links and reparse points' }
    if (-not $symlinkRejected) { throw 'A ZIP symlink entry was not rejected.' }

    $caseCollisionArchive = Join-Path $temporaryRoot 'case-collision.zip'
    $stream = [System.IO.File]::Create($caseCollisionArchive)
    try {
        $zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
        try {
            foreach ($name in @('payload/File.txt', 'payload/file.TXT')) {
                $entry = $zip.CreateEntry($name)
                $writer = New-Object System.IO.StreamWriter($entry.Open())
                try { $writer.Write($name) } finally { $writer.Dispose() }
            }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
    $caseCollisionRejected = $false
    try { Expand-PpMcpSafeArchive -ArchivePath $caseCollisionArchive -DestinationPath (Join-Path $temporaryRoot 'case-collision-expanded') }
    catch { $caseCollisionRejected = $_.Exception.Message -match 'case-colliding' }
    if (-not $caseCollisionRejected) { throw 'A case-colliding ZIP entry was not rejected.' }

    $privateKey = if ($PrivateKeyPath) { [System.IO.Path]::GetFullPath($PrivateKeyPath) } else { Join-Path $env:LOCALAPPDATA 'PremiereMCP\release-signing-private.xml' }
    $publicKey = Join-Path $repoRoot 'scripts\install\release-signing-public.xml'
    if ((Test-Path -LiteralPath $privateKey) -and (Test-Path -LiteralPath $publicKey)) {
        $input = Join-Path $temporaryRoot 'signed.txt'
        $signature = "$input.sig"
        [System.IO.File]::WriteAllText($input, 'release-signature-test', (New-Object System.Text.UTF8Encoding($false)))
        Write-PpMcpDetachedSignature -InputPath $input -SignaturePath $signature -PrivateKeyPath $privateKey
        Assert-PpMcpDetachedSignature -InputPath $input -SignaturePath $signature -PublicKeyPath $publicKey
        [System.IO.File]::AppendAllText($input, 'tampered')
        $tamperRejected = $false
        try { Assert-PpMcpDetachedSignature -InputPath $input -SignaturePath $signature -PublicKeyPath $publicKey }
        catch { $tamperRejected = $_.Exception.Message -match 'verification failed' }
        if (-not $tamperRejected) { throw 'Tampered detached signature was accepted.' }
    }

    if (-not $ArchivePath) {
        $package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
        $ArchivePath = Join-Path $repoRoot "artifacts\premiere-pro-full-mcp-v$($package.version)-windows.zip"
    }
    $ArchivePath = [System.IO.Path]::GetFullPath($ArchivePath)
    if (-not $ManifestPath) { $ManifestPath = "$ArchivePath.manifest.json" }
    if (-not $SignaturePath) { $SignaturePath = "$ManifestPath.sig" }
    $releaseArtifactsAvailable = (Test-Path -LiteralPath $ArchivePath -PathType Leaf) -and
        (Test-Path -LiteralPath $ManifestPath -PathType Leaf) -and
        (Test-Path -LiteralPath $SignaturePath -PathType Leaf)
    if ($RequireReleaseArtifacts -and -not $releaseArtifactsAvailable) { throw 'Final release artifacts are required for release-boundary security tests.' }

    if ($releaseArtifactsAvailable) {
        $signed = Read-PpMcpSignedReleaseManifest -ManifestPath $ManifestPath -SignaturePath $SignaturePath -ExpectedRepository $script:PpMcpRepository
        $releaseTestRoot = Join-Path $temporaryRoot 'release-boundary'
        New-Item -ItemType Directory -Path $releaseTestRoot -Force | Out-Null

        $extraExpanded = Join-Path $releaseTestRoot 'extra-expanded'
        Expand-PpMcpSafeArchive -ArchivePath $ArchivePath -DestinationPath $extraExpanded
        $extraBundle = @(Get-ChildItem -LiteralPath $extraExpanded -Directory)[0].FullName
        [System.IO.File]::WriteAllText((Join-Path $extraBundle 'UNLISTED-SECURITY-TEST.txt'), 'must be rejected', (New-Object System.Text.UTF8Encoding($false)))
        $extraInstallRoot = Join-Path $releaseTestRoot 'extra-install'
        $extraCepRoot = Join-Path $releaseTestRoot 'extra-cep'
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $extraBundle 'Install.ps1') -InstallRoot $extraInstallRoot -CepInstallRoot $extraCepRoot -PackagePath $extraBundle -SkipCodexRegistration -SkipCcxLaunch *> (Join-Path $releaseTestRoot 'extra-file.log')
        $extraExitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousErrorActionPreference
        if ($extraExitCode -eq 0 -or (Test-Path -LiteralPath (Join-Path $extraInstallRoot 'app\current.json'))) { throw 'An unlisted release-package file was not rejected before installation.' }

        $downgradeRoot = Join-Path $releaseTestRoot 'downgrade-install'
        $downgradeCepRoot = Join-Path $releaseTestRoot 'downgrade-cep'
        New-Item -ItemType Directory -Path (Join-Path $downgradeRoot 'app') -Force | Out-Null
        Write-PpMcpJsonAtomic -Path (Join-Path $downgradeRoot 'app\current.json') -Value ([ordered]@{ version = '99.0.0'; automationMode = 'interactive' })
        $ErrorActionPreference = 'Continue'
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'scripts\install\Update.ps1') -InstallRoot $downgradeRoot -CepInstallRoot $downgradeCepRoot -PackagePath $ArchivePath -ManifestPath $ManifestPath -SignaturePath $SignaturePath -SkipCodexRegistration -SkipCcxLaunch *> (Join-Path $releaseTestRoot 'downgrade.log')
        $downgradeExitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousErrorActionPreference
        $installedVersion = [string]((Get-Content -LiteralPath (Join-Path $downgradeRoot 'app\current.json') -Raw | ConvertFrom-Json).version)
        if ($downgradeExitCode -eq 0 -or $installedVersion -ne '99.0.0') { throw 'A signed downgrade was not rejected without changing the installed version.' }

        if (Test-Path -LiteralPath $privateKey -PathType Leaf) {
            $rollbackExpanded = Join-Path $releaseTestRoot 'rollback-expanded'
            Expand-PpMcpSafeArchive -ArchivePath $ArchivePath -DestinationPath $rollbackExpanded
            $rollbackBundle = @(Get-ChildItem -LiteralPath $rollbackExpanded -Directory)[0].FullName
            $launcherRelative = 'payload/native/win-x64/PremiereMcp.WindowsUiAgent.exe'
            $launcherPath = Join-Path $rollbackBundle ($launcherRelative.Replace('/', '\'))
            Copy-Item -LiteralPath (Join-Path $env:WINDIR 'System32\where.exe') -Destination $launcherPath -Force
            $hashManifest = Join-Path $rollbackBundle 'MANIFEST.sha256'
            $hashLines = @(Get-Content -LiteralPath $hashManifest)
            $launcherMatched = $false
            $hashLines = @($hashLines | ForEach-Object {
                if ($_ -match '^([a-f0-9]{64}) \*(.+)$' -and $Matches[2].Replace('\', '/') -ceq $launcherRelative) {
                    $launcherMatched = $true
                    "$(Get-PpMcpSha256 -Path $launcherPath) *$launcherRelative"
                } else { $_ }
            })
            if (-not $launcherMatched) { throw 'Could not locate the launcher in the release hash manifest.' }
            [System.IO.File]::WriteAllText($hashManifest, ($hashLines -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
            Write-PpMcpDetachedSignature -InputPath $hashManifest -SignaturePath (Join-Path $rollbackBundle 'MANIFEST.sha256.sig') -PrivateKeyPath $privateKey

            $rollbackInstallRoot = Join-Path $releaseTestRoot 'rollback-install'
            $rollbackCepRoot = Join-Path $releaseTestRoot 'rollback-cep'
            $rollbackTargets = @(
                (Join-Path $rollbackInstallRoot 'bin'), (Join-Path $rollbackInstallRoot 'bundle'),
                (Join-Path $rollbackInstallRoot 'generated'), (Join-Path $rollbackInstallRoot 'runtime'),
                (Join-Path $rollbackInstallRoot "uxp-plugin-$($signed.version)"), (Join-Path $rollbackInstallRoot 'app'),
                $rollbackCepRoot
            )
            foreach ($target in $rollbackTargets) {
                New-Item -ItemType Directory -Path $target -Force | Out-Null
                [System.IO.File]::WriteAllText((Join-Path $target 'original.marker'), $target, (New-Object System.Text.UTF8Encoding($false)))
            }
            # Interactive installs no longer execute the native launcher now that the
            # legacy UXP token/bootstrap provisioning step has been removed. Exercise
            # the same post-activation rollback boundary through the supported Trust
            # Profile enrollment path, where the deliberately substituted launcher
            # must fail after all release targets have been activated.
            $rollbackTrustProfile = Join-Path $releaseTestRoot 'rollback-trust-profile.json'
            [System.IO.File]::WriteAllText(
                $rollbackTrustProfile,
                '{"schemaVersion":1,"profileId":"rollback-test","mode":"trusted_unattended"}',
                (New-Object System.Text.UTF8Encoding($false)))
            $rollbackLog = Join-Path $releaseTestRoot 'rollback.log'
            $ErrorActionPreference = 'Continue'
            & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $rollbackBundle 'Install.ps1') -InstallRoot $rollbackInstallRoot -CepInstallRoot $rollbackCepRoot -PackagePath $rollbackBundle -AutomationMode trusted_unattended -TrustProfilePath $rollbackTrustProfile -SkipCodexRegistration -SkipCcxLaunch *> $rollbackLog
            $rollbackExitCode = $LASTEXITCODE
            $ErrorActionPreference = $previousErrorActionPreference
            if ($rollbackExitCode -eq 0) { throw 'The forced partial installation unexpectedly succeeded.' }
            if ((Get-Content -LiteralPath $rollbackLog -Raw) -notmatch 'Trust profile enrollment failed') { throw 'The rollback probe did not reach the post-activation Trust Profile enrollment boundary.' }
            foreach ($target in $rollbackTargets) {
                if (-not (Test-Path -LiteralPath (Join-Path $target 'original.marker') -PathType Leaf)) { throw "Partial-install rollback did not restore: $target" }
            }
            if (@(Get-ChildItem -LiteralPath $rollbackInstallRoot -Directory -Filter '.install-stage-*' -Force).Count) { throw 'Partial-install rollback left a staging directory.' }
        } elseif ($RequireReleaseArtifacts) { throw 'The release signing key is required for the forced partial-install rollback test.' }
    } else {
        Write-Host 'Release-boundary tests skipped because final signed artifacts are not present.'
    }
    Write-Host 'Release security tests passed: traversal, UDT attributes, symlink, case collision, signature tamper, extra file, downgrade, and partial-install rollback.'
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}
