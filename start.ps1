# Copilot Town — Start the server
# Usage: .\start.ps1              (start server, open dashboard)
#        .\start.ps1 -NoBrowser   (start server only)
#        .\start.ps1 -Dev         (start in dev mode with hot-reload)
#
# The server runs silently in the background on port 3848.
# No Copilot session needed — just run this script.

param(
  [switch]$NoBrowser,
  [switch]$Dev
)

$root = $PSScriptRoot
$port = if ($env:COPILOT_TOWN_PORT) { $env:COPILOT_TOWN_PORT } else { "3848" }

# Check if already running
$listening = netstat -ano 2>$null | Select-String ":${port}\s.*LISTEN"
if ($listening) {
  Write-Host "[copilot-town] Server already running on port $port" -ForegroundColor Yellow
  if (-not $NoBrowser) {
    Start-Process "http://localhost:$port"
  }
  exit 0
}

# Ensure deps
$nm = Join-Path $root "node_modules"
if (-not (Test-Path $nm)) {
  Write-Host "[copilot-town] Installing dependencies..." -ForegroundColor Cyan
  Push-Location $root
  npm install --silent --no-progress 2>$null
  Pop-Location
}

if ($Dev) {
  # Dev mode: foreground with hot-reload
  Write-Host "[copilot-town] Starting in dev mode (port $port)..." -ForegroundColor Cyan
  Push-Location $root
  npx tsx watch server/index.ts
  Pop-Location
} else {
  # Production: silent background process
  $tsx = Join-Path $root "node_modules\tsx\dist\cli.mjs"
  $serverScript = Join-Path $root "server\index.ts"
  $logFile = Join-Path $env:USERPROFILE ".copilot\copilot-town.log"
  $pidFile = Join-Path $env:USERPROFILE ".copilot\copilot-town.pid"

  # Ensure log directory
  $logDir = Split-Path $logFile
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

  $node = (Get-Command node -ErrorAction Stop).Source
  # Start-Process can't redirect stdout+stderr to same file, so use cmd wrapper
  $proc = Start-Process -FilePath $node -ArgumentList $tsx, $serverScript `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru

  # Save PID
  $proc.Id | Out-File -FilePath $pidFile -NoNewline

  # Wait for server to be ready
  $ready = $false
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 500
    $check = netstat -ano 2>$null | Select-String ":${port}\s.*LISTEN"
    if ($check) { $ready = $true; break }
  }

  if ($ready) {
    Write-Host "[copilot-town] Server running on port $port (PID: $($proc.Id))" -ForegroundColor Green
    Write-Host "[copilot-town] Dashboard: http://localhost:$port" -ForegroundColor Green
    Write-Host "[copilot-town] Logs: $logFile" -ForegroundColor DarkGray
    if (-not $NoBrowser) {
      Start-Process "http://localhost:$port"
    }
  } else {
    Write-Host "[copilot-town] Server failed to start. Check logs: $logFile" -ForegroundColor Red
    exit 1
  }
}
