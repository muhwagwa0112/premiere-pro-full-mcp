param(
    [Parameter(Mandatory = $true)][string]$PackagePath,
    [Parameter(Mandatory = $true)][string]$ToolPath,
    [int]$PremierePid = 0
)

$ErrorActionPreference = "Stop"
$package = [System.IO.Path]::GetFullPath($PackagePath)
$tool = [System.IO.Path]::GetFullPath($ToolPath)
$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) "cep-plugin"))

if (-not (Test-Path -LiteralPath $package -PathType Leaf)) { throw "Signed package missing: $package" }
if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "ZXPSignCmd missing: $tool" }

$premiere = if ($PremierePid -gt 0) { Get-Process -Id $PremierePid -ErrorAction SilentlyContinue } else { $null }
if ($premiere) {
    if ($premiere.MainWindowTitle -and $premiere.MainWindowTitle -match "\*$") {
        throw "Premiere indicates unsaved changes; signed CEP install refused."
    }
    if (-not $premiere.CloseMainWindow()) { throw "Premiere did not accept a normal close; no force close was attempted." }
    if (-not $premiere.WaitForExit(45000)) { throw "Premiere normal close did not complete; no force close was attempted." }
}
if (@(Get-Process -Name "Adobe Premiere Pro", "CEPHtmlEngine" -ErrorAction SilentlyContinue).Count -gt 0) {
    throw "Premiere or CEP remains running; signed install refused."
}

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pp-mcp-signed-install-" + [guid]::NewGuid().ToString("N"))
$staging = Join-Path $stagingRoot "extension"
New-Item -ItemType Directory -Path $staging | Out-Null
tar.exe -xf $package -C $staging
if ($LASTEXITCODE -ne 0) { throw "Signed ZXP extraction failed with exit code $LASTEXITCODE" }

$expectedFiles = @("CSInterface.js", "CSXS\manifest.xml", "index.html", "main.ws.js", "META-INF\signatures.xml", "mimetype")
$observedFiles = @(Get-ChildItem -LiteralPath $staging -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($staging.Length + 1) })
$unexpected = @($observedFiles | Where-Object { $expectedFiles -cnotcontains $_ })
$missing = @($expectedFiles | Where-Object { $observedFiles -cnotcontains $_ })
if ($unexpected.Count -gt 0 -or $missing.Count -gt 0) {
    throw "Signed ZXP file set mismatch. Unexpected=$($unexpected -join ','), Missing=$($missing -join ',')"
}
foreach ($relative in @("CSInterface.js", "CSXS\manifest.xml", "index.html", "main.ws.js")) {
    $sourceHash = (Get-FileHash -LiteralPath (Join-Path $sourceRoot $relative) -Algorithm SHA256).Hash
    $stagedHash = (Get-FileHash -LiteralPath (Join-Path $staging $relative) -Algorithm SHA256).Hash
    if ($sourceHash -cne $stagedHash) { throw "Signed content mismatch: $relative" }
}
& $tool -verify $staging
if ($LASTEXITCODE -ne 0) { throw "Extracted signed extension verification failed with exit code $LASTEXITCODE" }

$extensionsRoot = [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA "Adobe\CEP\extensions"))
$destination = [System.IO.Path]::GetFullPath((Join-Path $extensionsRoot "com.codex.premiere-pro-full-mcp.cep"))
if (-not [string]::Equals((Split-Path -Parent $destination), $extensionsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe CEP destination: $destination"
}
$quarantineRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "PremiereMCP\quarantine\cep-signed-install"))
$quarantine = [System.IO.Path]::GetFullPath((Join-Path $quarantineRoot ((Get-Date -Format "yyyyMMdd-HHmmssfff") + "-com.codex.premiere-pro-full-mcp.cep")))
$prefix = $quarantineRoot.TrimEnd("\") + "\"
if (-not $quarantine.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe CEP quarantine destination: $quarantine"
}
New-Item -ItemType Directory -Force -Path $quarantineRoot | Out-Null

$oldMoved = $false
try {
    if (Test-Path -LiteralPath $destination -PathType Container) {
        Move-Item -LiteralPath $destination -Destination $quarantine
        $oldMoved = $true
    }
    Move-Item -LiteralPath $staging -Destination $destination
    & $tool -verify $destination
    if ($LASTEXITCODE -ne 0) { throw "Installed signed extension verification failed with exit code $LASTEXITCODE" }
} catch {
    if (Test-Path -LiteralPath $destination -PathType Container) {
        Remove-Item -LiteralPath $destination -Recurse -Force
    }
    if ($oldMoved -and (Test-Path -LiteralPath $quarantine -PathType Container)) {
        Move-Item -LiteralPath $quarantine -Destination $destination
    }
    throw
}

[pscustomobject]@{
    installed = $true
    destination = $destination
    rollbackPath = if ($oldMoved) { $quarantine } else { $null }
    packageSha256 = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
    installedMainHash = (Get-FileHash -LiteralPath (Join-Path $destination "main.ws.js") -Algorithm SHA256).Hash.ToLowerInvariant()
    signaturePresent = Test-Path -LiteralPath (Join-Path $destination "META-INF\signatures.xml")
} | ConvertTo-Json -Compress
