# Copilot Town CLI — start, stop, or open the dashboard
# Usage:
#   copilot-town start          Start the server (background)
#   copilot-town stop           Stop the server
#   copilot-town open           Open dashboard in browser
#   copilot-town status         Show server status
#
# Installation (add to PowerShell profile):
#   Set-Alias copilot-town "$env:USERPROFILE\.copilot\installed-plugins\_direct\GittyHarsha--copilot-town\scripts\copilot-town.ps1"

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'open', 'status')]
  [string]$Action = 'status'
)

$root = Split-Path $PSScriptRoot -Parent
$port = if ($env:COPILOT_TOWN_PORT) { $env:COPILOT_TOWN_PORT } else { "3848" }

function Test-ServerRunning {
  $null -ne (netstat -ano 2>$null | Select-String ":${port}\s.*LISTEN")
}

switch ($Action) {
  'start' {
    & "$root\start.ps1" @args
  }
  'stop' {
    & "$root\stop.ps1"
  }
  'open' {
    if (Test-ServerRunning) {
      Start-Process "http://localhost:$port"
      Write-Host "[copilot-town] Dashboard opened" -ForegroundColor Green
    } else {
      Write-Host "[copilot-town] Server not running. Use: copilot-town start" -ForegroundColor Yellow
    }
  }
  'status' {
    if (Test-ServerRunning) {
      Write-Host "[copilot-town] Server running on port $port" -ForegroundColor Green
      Write-Host "[copilot-town] Dashboard: http://localhost:$port" -ForegroundColor Cyan
    } else {
      Write-Host "[copilot-town] Server not running" -ForegroundColor Yellow
    }
  }
}
