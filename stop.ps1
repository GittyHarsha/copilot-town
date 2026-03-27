# Copilot Town — Stop the server
# Usage: .\stop.ps1

$pidFile = Join-Path $env:USERPROFILE ".copilot\copilot-town.pid"
$port = if ($env:COPILOT_TOWN_PORT) { $env:COPILOT_TOWN_PORT } else { "3848" }

if (Test-Path $pidFile) {
  $serverPid = [int](Get-Content $pidFile -Raw).Trim()
  try {
    Stop-Process -Id $serverPid -Force -ErrorAction Stop
    Write-Host "[copilot-town] Server stopped (PID: $serverPid)" -ForegroundColor Green
  } catch {
    Write-Host "[copilot-town] Process $serverPid not running" -ForegroundColor Yellow
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
} else {
  # Fallback: find by port
  $listening = netstat -ano 2>$null | Select-String ":${port}\s.*LISTEN"
  if ($listening) {
    $lineText = $listening[0].ToString().Trim()
    $serverPid = [int]($lineText -split '\s+')[-1]
    Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
    Write-Host "[copilot-town] Server stopped (PID: $serverPid)" -ForegroundColor Green
  } else {
    Write-Host "[copilot-town] Server not running" -ForegroundColor Yellow
  }
}
