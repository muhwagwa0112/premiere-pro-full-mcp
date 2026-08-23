[CmdletBinding()]
param()

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

    $privateKey = Join-Path $env:LOCALAPPDATA 'PremiereMCP\release-signing-private.xml'
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
    Write-Host 'Release security tests passed: ZIP traversal and detached-signature tamper rejection.'
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}
