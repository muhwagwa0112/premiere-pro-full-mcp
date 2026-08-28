param(
    [Parameter(Mandatory = $true)][string]$ToolPath,
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$WorkingRoot,
    [Parameter(Mandatory = $true)][string]$PackageRoot
)

$ErrorActionPreference = "Stop"
$tool = [System.IO.Path]::GetFullPath($ToolPath)
$source = [System.IO.Path]::GetFullPath($SourceRoot)
$working = [System.IO.Path]::GetFullPath($WorkingRoot)
$packages = [System.IO.Path]::GetFullPath($PackageRoot)

if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "ZXPSignCmd not found: $tool" }
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "CEP source not found: $source" }
New-Item -ItemType Directory -Force -Path $working | Out-Null
New-Item -ItemType Directory -Force -Path $packages | Out-Null

$certificate = Join-Path $working "premiere-mcp-local.p12"
$unsignedOutput = Join-Path $working "premiere-mcp-cep-signed.zxp"
$password = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")

try {
    & $tool -selfSignedCert KR Seoul PremiereMCP "PremiereMCP Local CEP" $password $certificate -validityDays 3650
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $certificate -PathType Leaf)) {
        throw "Self-signed certificate generation failed with exit code $LASTEXITCODE"
    }

    & $tool -sign $source $unsignedOutput $certificate $password
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $unsignedOutput -PathType Leaf)) {
        throw "CEP signing failed with exit code $LASTEXITCODE"
    }

    $verification = @(& $tool -verify $unsignedOutput -certinfo -skipOnlineRevocationChecks 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Signed ZXP verification failed with exit code $LASTEXITCODE" }

    $packagePath = Join-Path $packages ("premiere-mcp-cep-signed-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".zxp")
    Copy-Item -LiteralPath $unsignedOutput -Destination $packagePath
    [pscustomobject]@{
        packagePath = $packagePath
        sha256 = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
        size = (Get-Item -LiteralPath $packagePath).Length
        certificateDeleted = $true
        verification = ($verification -join " ")
    } | ConvertTo-Json -Compress
} finally {
    $password = $null
    if (Test-Path -LiteralPath $certificate) { Remove-Item -LiteralPath $certificate -Force }
}
