# Run the bridge (which starts tunnel-client itself) at every Windows logon, as a
# Scheduled Task for the signed-in user, so its approval dialogs appear on screen.
#   $env:TUNNEL_CLIENT="C:\path\to\tunnel-client.exe"; $env:TUNNEL_PROFILE="<profile>"; npm run service:install
#   npm run service:status | service:restart | service:logs | service:uninstall
param([Parameter(Position = 0)][string]$Cmd)
$ErrorActionPreference = 'Stop'

$Name = 'GPTWorkRouter'
$Dir = Split-Path -Parent $PSScriptRoot
$Data = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $HOME '.gptworkrouter' }
$Log = Join-Path (Join-Path $env:LOCALAPPDATA 'gptworkrouter') 'gptworkrouter.log'
$Port = if ($env:PORT) { $env:PORT } else { '3210' }
# Not $env:USERDOMAIN: it can read WORKGROUP (e.g. over SSH), which Task Scheduler rejects.
$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# Stop-ScheduledTask ends only conhost, not the node under it: also stop the supervisor
# (windows-run.mjs) with everything it started (bridge, tunnel-client, cloudflared).
function Stop-Bridge {
  Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*windows-run.mjs*' } |
    ForEach-Object { taskkill.exe /PID $_.ProcessId /T /F | Out-Null }
}

function Remove-Bridge {
  if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
    Stop-Bridge
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
  }
}

switch ($Cmd) {
  'install' {
    New-Item -ItemType Directory -Force $Data | Out-Null
    Remove-Bridge  # stop the old bridge first: its tunnel-client holds files in $bin
    $settings = @{ log = $Log; env = @{} }
    # The tunnel is optional: the setup wizard sets TUNNEL_CLIENT/TUNNEL_PROFILE; the relay needs nothing here.
    if ($env:TUNNEL_CLIENT) {
      if (-not $env:TUNNEL_PROFILE) { throw 'Set TUNNEL_PROFILE to the tunnel-client profile name' }
      if (-not (Test-Path -LiteralPath $env:TUNNEL_CLIENT -PathType Leaf)) { throw "Not a file: $env:TUNNEL_CLIENT" }
      # A background task may not reach Downloads, so keep a copy of the tunnel-client
      # folder (it ships its own cloudflared) next to the bridge data.
      $src = Split-Path -Parent (Resolve-Path -LiteralPath $env:TUNNEL_CLIENT).Path
      $bin = Join-Path $Data 'tunnel-client'
      if ($src -ne $bin) {
        if (Test-Path -LiteralPath $bin) { Remove-Item -LiteralPath $bin -Recurse -Force }
        Copy-Item -LiteralPath $src -Destination $bin -Recurse
      }
      $settings.tunnelClient = Join-Path $bin (Split-Path -Leaf $env:TUNNEL_CLIENT)
      $settings.tunnelProfile = $env:TUNNEL_PROFILE
    }
    # Only for users behind a proxy (set by the setup wizard).
    foreach ($k in 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'PORT') {
      $v = [Environment]::GetEnvironmentVariable($k)
      if ($v) { $settings.env[$k] = $v }
    }
    $settings | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Data 'service.json') -Encoding UTF8

    # service.mjs passes the Node it runs on (the installer's bundled one); else the one on PATH.
    $node = if ($env:GWR_NODE) { $env:GWR_NODE } else { (Get-Command node).Source }
    # conhost --headless: node is a console program; this keeps a window from opening.
    $action = New-ScheduledTaskAction -Execute 'conhost.exe' `
      -Argument "--headless `"$node`" `"$Dir\scripts\windows-run.mjs`"" -WorkingDirectory $Dir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
      -Description 'GPTWorkRouter bridge: lets ChatGPT hand tasks to Codex on this computer' | Out-Null
    Start-ScheduledTask -TaskName $Name
    Write-Output "Installed. Starts at every logon. Log: $Log"
  }
  'uninstall' {
    Remove-Bridge
    Write-Output 'Removed.'
  }
  'restart' {
    Stop-Bridge
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName $Name
  }
  'status' {
    $t = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $t) { Write-Output 'not installed' }
    else {
      $i = Get-ScheduledTaskInfo -TaskName $Name
      Write-Output "state = $($t.State)  last result = $($i.LastTaskResult)  last run = $($i.LastRunTime)"
    }
    try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port/health").Content }
    catch { Write-Output 'bridge not answering' }
  }
  'logs' { Get-Content -LiteralPath $Log -Tail 50 -Wait }
  default { Write-Output 'usage: service.ps1 install|uninstall|restart|status|logs'; exit 1 }
}
