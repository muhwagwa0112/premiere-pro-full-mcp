param(
    [switch]$Uninstall
)
# Register (or unregister) the always-on Premiere bridge daemon so it starts
# automatically at user logon. The daemon keeps a fixed loopback WebSocket
# open regardless of whether Premiere Pro is running, so the MCP server and
# the Premiere CEP extension never need a manual "start the bridge" step.

$ErrorActionPreference = "Stop"
$taskName = "Premiere MCP Bridge Daemon"
$repoRoot = Split-Path -Parent $PSScriptRoot
$daemonJs = Join-Path $repoRoot "dist\daemon.js"
$endpointFile = Join-Path $env:LOCALAPPDATA "PremiereMCP\bridge-endpoint.json"
$expectedPort = 48210

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "Removed scheduled task '$taskName'."
    } else {
        Write-Host "No scheduled task '$taskName' found; nothing to do."
    }
    return
}

if (-not (Test-Path $daemonJs)) {
    Write-Error "daemon.js not found at $daemonJs. Run 'npm run build' first."
    exit 1
}

$nodeExe = (Get-Command node).Source
if (-not $nodeExe) {
    Write-Error "Node.js not found in PATH."
    exit 1
}

$wrapper = Join-Path $PSScriptRoot "daemon-task-wrapper.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`"" -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered scheduled task '$taskName' -> $nodeExe $daemonJs"
Write-Host "The bridge daemon will auto-start at next logon."

# Start it right now if no daemon is already listening on the fixed port.
$alreadyListening = Get-NetTCPConnection -LocalPort $expectedPort -State Listen -ErrorAction SilentlyContinue
if ($alreadyListening) {
    Write-Host "Bridge daemon is already running on port $expectedPort; nothing to start."
} else {
    $proc = Start-Process -FilePath $nodeExe -ArgumentList "`"$daemonJs`"" -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    Write-Host "Started daemon now (pid $($proc.Id))."
}
