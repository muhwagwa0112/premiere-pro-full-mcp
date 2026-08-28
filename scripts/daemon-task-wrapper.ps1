param()
# Long-running wrapper for the "Premiere MCP Bridge Daemon" scheduled task.
# The wrapper owns the Node process and propagates its exit status so Task
# Scheduler's RestartCount/RestartInterval settings can actually observe and
# recover a daemon crash.

$ErrorActionPreference = "Stop"
$node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $node)) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { return }
    $node = $cmd.Source
}

$daemon = Join-Path $PSScriptRoot "..\dist\daemon.js"
if (-not (Test-Path $daemon)) { return }

Push-Location (Split-Path -Parent $daemon)
try {
    & $node $daemon
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
