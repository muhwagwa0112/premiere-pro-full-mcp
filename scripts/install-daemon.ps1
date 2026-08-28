param(
    [switch]$Uninstall,
    [switch]$Restart
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
if ($alreadyListening -and $Restart) {
    $owners = @($alreadyListening | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -ne 1) {
        Write-Error "Cannot safely restart port $expectedPort because it has $($owners.Count) owning processes."
        exit 1
    }
    $ownerPid = [int]$owners[0]
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction Stop
    $normalizedDaemon = [System.IO.Path]::GetFullPath($daemonJs)
    $tokens = @([regex]::Matches([string]$owner.CommandLine, '"([^"]+)"|(\S+)') | ForEach-Object {
        if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
    })
    $ownerDaemon = $tokens | Where-Object { $_ -and $_.EndsWith('daemon.js', [System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    if ($ownerDaemon) { $ownerDaemon = [System.IO.Path]::GetFullPath($ownerDaemon) }
    $expectedNode = [System.IO.Path]::GetFullPath($nodeExe)
    $ownerNode = if ($owner -and $owner.ExecutablePath) { [System.IO.Path]::GetFullPath($owner.ExecutablePath) } else { $null }
    if (-not $owner -or -not $ownerDaemon -or
        -not [string]::Equals($ownerDaemon, $normalizedDaemon, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($ownerNode, $expectedNode, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Error "Refusing to stop PID $ownerPid because it is not the expected daemon: $normalizedDaemon"
        exit 1
    }
    Stop-Process -Id $ownerPid -Force -ErrorAction Stop
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 200
        $alreadyListening = Get-NetTCPConnection -LocalPort $expectedPort -State Listen -ErrorAction SilentlyContinue
    } while ($alreadyListening -and [DateTime]::UtcNow -lt $deadline)
    if ($alreadyListening) {
        Write-Error "Port $expectedPort did not close after stopping daemon PID $ownerPid."
        exit 1
    }
    Write-Host "Stopped previous daemon PID $ownerPid."
}
if ($alreadyListening) {
    Write-Host "Bridge daemon is already running on port $expectedPort; nothing to start."
} else {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $alreadyListening = Get-NetTCPConnection -LocalPort $expectedPort -State Listen -ErrorAction SilentlyContinue
    } while (-not $alreadyListening -and [DateTime]::UtcNow -lt $deadline)
    if (-not $alreadyListening) {
        $task = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
        Write-Error "Scheduled daemon did not listen on port $expectedPort within 15 seconds (LastTaskResult=$($task.LastTaskResult))."
        exit 1
    }
    $ownerPid = ($alreadyListening | Select-Object -First 1 -ExpandProperty OwningProcess)
    Write-Host "Started daemon under Task Scheduler ownership (pid $ownerPid)."
}
