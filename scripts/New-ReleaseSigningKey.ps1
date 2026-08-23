[CmdletBinding()]
param(
    [string]$PrivateKeyPath = '',
    [string]$PublicKeyPath = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($PrivateKeyPath)) {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable. Pass -PrivateKeyPath explicitly.' }
    $PrivateKeyPath = Join-Path $env:LOCALAPPDATA 'PremiereMCP\release-signing-private.xml'
}
if ([string]::IsNullOrWhiteSpace($PublicKeyPath)) { $PublicKeyPath = Join-Path $repoRoot 'scripts\install\release-signing-public.xml' }
$PrivateKeyPath = [System.IO.Path]::GetFullPath($PrivateKeyPath)
$PublicKeyPath = [System.IO.Path]::GetFullPath($PublicKeyPath)
if (-not $Force -and ((Test-Path -LiteralPath $PrivateKeyPath) -or (Test-Path -LiteralPath $PublicKeyPath))) {
    throw 'A release signing key already exists. Refusing to replace the release trust root without -Force.'
}

New-Item -ItemType Directory -Path (Split-Path -Parent $PrivateKeyPath) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $PublicKeyPath) -Force | Out-Null
$rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider 3072
try {
    [System.IO.File]::WriteAllText($PrivateKeyPath, $rsa.ToXmlString($true) + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::WriteAllText($PublicKeyPath, $rsa.ToXmlString($false) + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
} finally { $rsa.Dispose() }

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner($identity)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $PrivateKeyPath -AclObject $acl

Write-Host "Premiere release signing key created."
Write-Host "Private key (user-only ACL): $PrivateKeyPath"
Write-Host "Public key: $PublicKeyPath"
