# Copilot Town CLI — start, stop, or open the dashboard
# Lives in the plugin's scripts/ dir. Works from any location.
#
# Usage:
#   .\copilot-town.ps1 start    Start the server (background)
#   .\copilot-town.ps1 stop     Stop the server
#   .\copilot-town.ps1 open     Open dashboard in browser
#   .\copilot-town.ps1 status   Show server status

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'open', 'status')]
  [string]$Action = 'status'
)

$root = Split-Path $PSScriptRoot -Parent
$port = if ($env:COPILOT_TOWN_PORT) { $env:COPILOT_TOWN_PORT } else { "3848" }
$logFile = Join-Path $env:USERPROFILE ".copilot\copilot-town.log"
$pidFile = Join-Path $env:USERPROFILE ".copilot\copilot-town.pid"

function Get-ServerPid {
  $match = netstat -ano 2>$null | Select-String ":${port}\s.*LISTEN"
  if ($match) {
    foreach ($line in $match) {
      if ($line.Line -match '\s(\d+)\s*$') { return [int]$Matches[1] }
    }
  }
  return $null
}

switch ($Action) {
  'start' {
    $existing = Get-ServerPid
    if ($existing) {
      Write-Host "[copilot-town] Server already running on port $port (PID: $existing)" -ForegroundColor Yellow
      Start-Process "http://localhost:$port"
      return
    }

    # Ensure deps
    $nm = Join-Path $root "node_modules"
    if (-not (Test-Path $nm)) {
      Write-Host "[copilot-town] Installing dependencies..." -ForegroundColor Cyan
      Push-Location $root
      npm install --silent --no-progress 2>$null
      Pop-Location
    }

    $tsx = Join-Path $root "node_modules\tsx\dist\cli.mjs"
    $serverScript = Join-Path $root "server\index.ts"
    $node = (Get-Command node -ErrorAction Stop).Source

    $proc = Start-Process -FilePath $node -ArgumentList $tsx, $serverScript `
      -WorkingDirectory $root -WindowStyle Hidden -PassThru
    $proc.Id | Out-File -FilePath $pidFile -NoNewline

    # Wait for ready
    $ready = $false
    for ($i = 0; $i -lt 15; $i++) {
      Start-Sleep -Milliseconds 500
      if (Get-ServerPid) { $ready = $true; break }
    }

    if ($ready) {
      Write-Host "[copilot-town] Server running on port $port (PID: $($proc.Id))" -ForegroundColor Green
      Write-Host "[copilot-town] Dashboard: http://localhost:$port" -ForegroundColor Green
      Write-Host "[copilot-town] Logs: $logFile" -ForegroundColor DarkGray
    } else {
      Write-Host "[copilot-town] Server failed to start. Check logs: $logFile" -ForegroundColor Red
    }
  }
  'stop' {
    $serverPid = Get-ServerPid
    if ($serverPid) {
      Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
      Write-Host "[copilot-town] Server stopped (PID: $serverPid)" -ForegroundColor Green
    } else {
      Write-Host "[copilot-town] Server not running" -ForegroundColor Yellow
    }
  }
  'open' {
    if (Get-ServerPid) {
      Start-Process "http://localhost:$port"
      Write-Host "[copilot-town] Dashboard opened" -ForegroundColor Green
    } else {
      Write-Host "[copilot-town] Server not running. Use: copilot-town.ps1 start" -ForegroundColor Yellow
    }
  }
  'status' {
    $serverPid = Get-ServerPid
    if ($serverPid) {
      Write-Host "[copilot-town] Server running on port $port (PID: $serverPid)" -ForegroundColor Green
      Write-Host "[copilot-town] Dashboard: http://localhost:$port" -ForegroundColor Cyan
    } else {
      Write-Host "[copilot-town] Server not running" -ForegroundColor Yellow
    }
  }
}
