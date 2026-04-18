if (-not $env:BACKEND_PORT) {
  $env:BACKEND_PORT = 3000
}

if (-not $env:RADIO_API) {
  $env:RADIO_API = "http://localhost:8080"
}

Write-Host "Starting YT Radio Backend..." -ForegroundColor Cyan
node backend/server.js
