# Copilot Town — start backend + frontend
# Usage: .\start.ps1            (both)
#        .\start.ps1 -backend   (server only)
#        .\start.ps1 -frontend  (client only)

param(
  [switch]$backend,
  [switch]$frontend
)

$root = $PSScriptRoot
if (-not $backend -and -not $frontend) { $backend = $true; $frontend = $true }

if ($backend) {
  Write-Host "[hub] Starting backend on :3848 ..." -ForegroundColor Cyan
  Start-Process -NoNewWindow -FilePath "npx" -ArgumentList "tsx server/index.ts" -WorkingDirectory $root
}

if ($frontend) {
  Write-Host "[hub] Starting frontend on :3847 ..." -ForegroundColor Cyan
  Start-Process -NoNewWindow -FilePath "npx" -ArgumentList "vite --port 3847" -WorkingDirectory "$root\client"
}

Write-Host "[hub] Running. Ctrl+C to stop." -ForegroundColor Green
