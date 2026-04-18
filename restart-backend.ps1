Write-Host "Restarting YT Radio Backend..." -ForegroundColor Cyan
Write-Host ""

# Find and kill backend processes (port 3000)
$backendProcesses = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | 
    Select-Object -ExpandProperty OwningProcess -Unique

if ($backendProcesses) {
    Write-Host "Stopping existing backend processes..." -ForegroundColor Yellow
    foreach ($pid in $backendProcesses) {
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        Write-Host "  Stopped process: $pid" -ForegroundColor Gray
    }
    Start-Sleep -Seconds 2
}

# Start backend
Write-Host ""
Write-Host "Starting backend..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "node backend/server.js" -WindowStyle Normal

Start-Sleep -Seconds 3

Write-Host ""
Write-Host "Backend restarted!" -ForegroundColor Green
Write-Host "Dashboard: http://localhost:3000" -ForegroundColor Cyan
Write-Host ""
