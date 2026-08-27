param()
# Silent wrapper for the "Premiere MCP Bridge Daemon" scheduled task.
#
# The upstream script registers the daemon to run directly as `node dist/daemon.js`.
# Running node.exe as a Scheduled Task action without a console can fail with
# 0xC0000142 (STATUS_DLL_INIT_FAILED) in some environments, leaving no daemon on
# the fixed port after logon. This wrapper starts node detached with a hidden
# window so the always-on bridge is reliably up, and exits immediately.

$ErrorActionPreference = "Stop"
$node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $node)) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { return }
    $node = $cmd.Source
}

$daemon = Join-Path $PSScriptRoot "..\dist\daemon.js"
if (-not (Test-Path $daemon)) { return }

Start-Process -FilePath $node -ArgumentList "`"$daemon`"" -WorkingDirectory (Split-Path -Parent $daemon) -WindowStyle Hidden -PassThru | Out-Null
