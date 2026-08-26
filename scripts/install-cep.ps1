param(
    [switch]$Force
)
# Deploy the always-on bridge CEP extension into Premiere Pro's CEP folder.
# Overwrites the files that belong to this extension (index.html, main.ws.js,
# CSInterface.js, CSXS/manifest.xml). Old per-extension artifacts that are no
# longer part of the rebuilt extension (host.jsx, main.js, loader.jsx, ...)
# are removed so they cannot shadow the new bridge.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repoRoot "cep-plugin"
$dstBase = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$dst = Join-Path $dstBase "com.codex.premiere-pro-full-mcp.cep"

if (-not (Test-Path $src)) {
    Write-Error "Source extension not found: $src"
    exit 1
}

New-Item -ItemType Directory -Force -Path $dst | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dst "CSXS") | Out-Null

# Copy the rebuilt extension files.
Copy-Item -Force (Join-Path $src "index.html") $dst
Copy-Item -Force (Join-Path $src "main.ws.js") $dst
if (Test-Path (Join-Path $src "CSInterface.js")) {
    Copy-Item -Force (Join-Path $src "CSInterface.js") $dst
}
Copy-Item -Force (Join-Path $src "CSXS\manifest.xml") (Join-Path $dst "CSXS\manifest.xml")

# Remove artifacts from the pre-rebuild design that are no longer used, so the
# new bridge cannot accidentally load an old host.
$stale = @("host.jsx", "host.ws.jsx", "host.tools.gen.jsx", "json-compat.jsx", "loader.jsx", "cep-runtime.js", "main.js")
foreach ($name in $stale) {
    $p = Join-Path $dst $name
    if (Test-Path $p) { Remove-Item -Force $p }
}

Write-Host "Deployed rebuilt CEP extension to: $dst"
Write-Host "Restart Premiere Pro to load the new bridge."
