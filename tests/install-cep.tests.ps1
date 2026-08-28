$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repoRoot "scripts\install-cep.ps1"
$installAll = Join-Path $repoRoot "scripts\install-all.ps1"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pp-mcp-install-cep-" + [guid]::NewGuid().ToString("N"))
$cepRoot = Join-Path $tempRoot "cep"
$quarantineRoot = Join-Path $tempRoot "quarantine"

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function New-TestExtension([string]$DirectoryName, [string]$BundleId, [string]$Root = $cepRoot) {
    $extensionRoot = Join-Path $Root $DirectoryName
    $manifestDirectory = Join-Path $extensionRoot "CSXS"
    New-Item -ItemType Directory -Force -Path $manifestDirectory | Out-Null
    $manifest = '<?xml version="1.0" encoding="UTF-8"?><ExtensionManifest Version="7.0" ExtensionBundleId="' + $BundleId + '" />'
    Set-Content -LiteralPath (Join-Path $manifestDirectory "manifest.xml") -Value $manifest -Encoding UTF8
    return $extensionRoot
}

try {
    New-Item -ItemType Directory -Force -Path $cepRoot | Out-Null

    # A similar folder name with a different manifest bundle ID must not match.
    $lookalike = New-TestExtension "com.local.ppmcp.cep.2026-lookalike" "example.safe.bundle"
    # Trailing primary and alternate separators exercise PS5.1-compatible path
    # normalization without changing the intended discovery root.
    $cepRootWithTrailingSeparators = $cepRoot + [System.IO.Path]::DirectorySeparatorChar + [System.IO.Path]::AltDirectorySeparatorChar
    & $installer -CepExtensionsRoot $cepRootWithTrailingSeparators -QuarantineRoot $quarantineRoot -AuditOnly
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $cepRoot "com.codex.premiere-pro-full-mcp.cep"))) "AuditOnly deployed the current extension"
    Assert-True (-not (Test-Path -LiteralPath $quarantineRoot)) "AuditOnly created the quarantine root"
    Assert-True (Test-Path -LiteralPath $lookalike -PathType Container) "AuditOnly moved a lookalike extension"

    & $installer -CepExtensionsRoot $cepRoot -QuarantineRoot $quarantineRoot
    Assert-True (Test-Path -LiteralPath $lookalike -PathType Container) "lookalike extension was moved"

    # Updating an unpacked development extension must remove signatures from a
    # previously installed signed package. Otherwise the copied files no longer
    # match the stale package digest and CEP can reject the whole extension.
    $currentExtension = Join-Path $cepRoot "com.codex.premiere-pro-full-mcp.cep"
    $staleSignatureDirectory = Join-Path $currentExtension "META-INF"
    New-Item -ItemType Directory -Force -Path $staleSignatureDirectory | Out-Null
    Set-Content -LiteralPath (Join-Path $staleSignatureDirectory "signatures.xml") -Value "stale signature" -Encoding UTF8
    & $installer -CepExtensionsRoot $cepRoot -QuarantineRoot $quarantineRoot
    Assert-True (-not (Test-Path -LiteralPath $staleSignatureDirectory)) "stale signed-package metadata survived unpacked CEP deployment"

    # AuditOnly fails closed on the exact bundle ID and remains read-only even
    # when the caller explicitly accepts a later quarantine.
    $legacy = New-TestExtension "arbitrary-folder-name" "com.local.ppmcp.cep.2026"
    $failedClosed = $false
    try {
        & $installer -CepExtensionsRoot $cepRoot -QuarantineRoot $quarantineRoot -AuditOnly
    } catch {
        $failedClosed = $_.Exception.Message.Contains("[CEP_LEGACY_CONFLICT]")
    }
    Assert-True $failedClosed "exact legacy bundle did not fail closed with CEP_LEGACY_CONFLICT"
    Assert-True (Test-Path -LiteralPath $legacy -PathType Container) "AuditOnly moved legacy extension without opt-in"

    # Track presence of the base quarantine root before/after this audit-only
    # run so the "audit must not create quarantine data" assertion is not
    # polluted by quarantine data already created by earlier deployment runs.
    $auditQuarantineRoot = Join-Path $tempRoot "quarantine-for-audit"
    & $installer -CepExtensionsRoot $cepRoot -QuarantineRoot $auditQuarantineRoot -AuditOnly -QuarantineKnownLegacyCep
    Assert-True (Test-Path -LiteralPath $legacy -PathType Container) "AuditOnly moved legacy extension with opt-in"
    Assert-True (-not (Test-Path -LiteralPath $auditQuarantineRoot)) "AuditOnly created quarantine data with opt-in"

    # A quarantine destination under the CEP discovery root is unsafe and must
    # be rejected before the legacy directory is moved.
    $unsafeQuarantineRejected = $false
    try {
        & $installer -CepExtensionsRoot $cepRoot -QuarantineRoot (Join-Path $cepRoot "quarantine") -AuditOnly -QuarantineKnownLegacyCep
    } catch {
        $unsafeQuarantineRejected = $_.Exception.Message.Contains("[CEP_LEGACY_UNSAFE_QUARANTINE]")
    }
    Assert-True $unsafeQuarantineRejected "quarantine inside the CEP discovery root was not rejected"
    Assert-True (Test-Path -LiteralPath $legacy -PathType Container) "legacy extension moved to an unsafe quarantine root"

    # Invalid replacement source must fail before deployment or quarantine.
    $invalidSource = Join-Path $tempRoot "invalid-source"
    New-Item -ItemType Directory -Force -Path $invalidSource | Out-Null
    $invalidQuarantineRoot = Join-Path $tempRoot "quarantine-for-invalid-source"
    $invalidSourceRejected = $false
    try {
        & $installer -CepSourceRoot $invalidSource -CepExtensionsRoot $cepRoot -QuarantineRoot $invalidQuarantineRoot -QuarantineKnownLegacyCep
    } catch {
        $invalidSourceRejected = $_.Exception.Message.Contains("[CEP_SOURCE_INCOMPLETE]")
    }
    Assert-True $invalidSourceRejected "incomplete current CEP source was not rejected"
    Assert-True (Test-Path -LiteralPath $legacy -PathType Container) "legacy extension moved after source validation failure"
    Assert-True (-not (Test-Path -LiteralPath $invalidQuarantineRoot)) "source validation failure created quarantine data"

    # A complete file set with the wrong current manifest identity must also
    # fail before touching the installed legacy bridge.
    $badIdentitySource = Join-Path $tempRoot "bad-identity-source"
    Copy-Item -LiteralPath (Join-Path $repoRoot "cep-plugin") -Destination $badIdentitySource -Recurse
    $badManifestPath = Join-Path $badIdentitySource "CSXS\manifest.xml"
    $badManifest = (Get-Content -LiteralPath $badManifestPath -Raw).Replace(
        'ExtensionBundleId="com.codex.premiere-pro-full-mcp.cep"',
        'ExtensionBundleId="example.wrong.current.bundle"'
    )
    Set-Content -LiteralPath $badManifestPath -Value $badManifest -Encoding UTF8
    $identityRejected = $false
    try {
        & $installer -CepSourceRoot $badIdentitySource -CepExtensionsRoot $cepRoot -QuarantineRoot $quarantineRoot -AuditOnly -QuarantineKnownLegacyCep
    } catch {
        $identityRejected = $_.Exception.Message.Contains("[CEP_SOURCE_IDENTITY_MISMATCH]")
    }
    Assert-True $identityRejected "wrong current CEP manifest identity was not rejected"
    Assert-True (Test-Path -LiteralPath $legacy -PathType Container) "legacy extension moved after manifest identity failure"

    # A destination creation failure after successful source validation must
    # still leave the working legacy bridge in place.
    $failingCepRoot = Join-Path $tempRoot "failing-cep"
    $failingQuarantineRoot = Join-Path $tempRoot "failing-quarantine"
    New-Item -ItemType Directory -Force -Path $failingCepRoot | Out-Null
    $failureLegacy = New-TestExtension "legacy-still-working" "com.local.ppmcp.cep.2026" $failingCepRoot
    Set-Content -LiteralPath (Join-Path $failingCepRoot "com.codex.premiere-pro-full-mcp.cep") -Value "blocks destination directory" -Encoding UTF8
    $deploymentFailed = $false
    try {
        & $installer -CepExtensionsRoot $failingCepRoot -QuarantineRoot $failingQuarantineRoot -QuarantineKnownLegacyCep
    } catch {
        $deploymentFailed = $true
    }
    Assert-True $deploymentFailed "injected destination failure did not stop deployment"
    Assert-True (Test-Path -LiteralPath $failureLegacy -PathType Container) "legacy extension moved after deployment failure"
    # The blocked current deployment sits where the current extension directory
    # is expected, so a successful rollback must not have replaced it with the
    # staging copy. The legacy bridge stays untouched; only the quarantine
    # base may be created to hold staging/backup metadata.
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $failingCepRoot "com.codex.premiere-pro-full-mcp.cep") -PathType Container)) "failed deployment replaced the blocked destination with a directory"

    # Explicit quarantine moves only the exact verified extension and records restoration data.
    & $installer -CepExtensionsRoot $cepRoot -QuarantineRoot $quarantineRoot -QuarantineKnownLegacyCep
    Assert-True (-not (Test-Path -LiteralPath $legacy)) "legacy extension remains in CEP discovery root"
    Assert-True (Test-Path -LiteralPath $lookalike -PathType Container) "lookalike extension was quarantined"
    # Earlier deployment runs legitimately append current-backup records, so
    # verify there is exactly one *known-legacy* quarantine record rather than
    # exactly one of every record kind.
    $records = @(Get-ChildItem -LiteralPath $quarantineRoot -Filter "quarantine.json" -File -Recurse | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json })
    $legacyRecords = @($records | Where-Object { $_.kind -eq "known-legacy-quarantine" -or $_.bundleId -ceq "com.local.ppmcp.cep.2026" })
    Assert-True ($legacyRecords.Count -eq 1) "expected exactly one known-legacy quarantine record"
    $record = $legacyRecords[0]
    Assert-True ($record.bundleId -ceq "com.local.ppmcp.cep.2026") "recorded bundle ID is incorrect"
    Assert-True ([string]::Equals($record.originalPath, [System.IO.Path]::GetFullPath($legacy), [System.StringComparison]::OrdinalIgnoreCase)) "original path was not recorded"
    Assert-True (Test-Path -LiteralPath $record.quarantinedPath -PathType Container) "quarantined extension path is missing"
    Assert-True (-not [string]::IsNullOrWhiteSpace($record.quarantinedAtUtc)) "quarantine time was not recorded"

    # The aggregate installer must complete CEP preflight before its first
    # daemon installation/restart call and propagate explicit quarantine intent.
    $installAllText = Get-Content -LiteralPath $installAll -Raw
    $preflightPosition = $installAllText.IndexOf('& (Join-Path $PSScriptRoot "install-cep.ps1") -AuditOnly')
    $daemonPosition = $installAllText.IndexOf('& (Join-Path $PSScriptRoot "install-daemon.ps1")')
    Assert-True ($preflightPosition -ge 0 -and $preflightPosition -lt $daemonPosition) "install-all does not preflight CEP before daemon mutation"
    Assert-True ($installAllText.Contains('-AuditOnly -QuarantineKnownLegacyCep')) "install-all does not propagate quarantine intent to preflight"

    Write-Host "install-cep focused tests passed"
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
