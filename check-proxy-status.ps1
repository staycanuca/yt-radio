# Check Proxy Manager Status
Write-Host "Checking Proxy Manager Status..." -ForegroundColor Cyan
Write-Host ""

# Wait a bit for testing to complete
Write-Host "Waiting 30 seconds for proxy testing to complete..." -ForegroundColor Yellow
Start-Sleep -Seconds 30

Write-Host ""
Write-Host "=== Proxy Stats (Radio) ===" -ForegroundColor Green
try {
    $response = Invoke-RestMethod -Uri "http://localhost:8080/proxy-stats" -Method Get
    $response | ConvertTo-Json -Depth 10
} catch {
    Write-Host "Error: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Proxy Stats (Backend) ===" -ForegroundColor Green
try {
    $response = Invoke-RestMethod -Uri "http://localhost:3000/api/stats/proxy" -Method Get
    $response | ConvertTo-Json -Depth 10
} catch {
    Write-Host "Error: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
if ($response.enabled) {
    Write-Host "✅ Proxy Manager: ENABLED" -ForegroundColor Green
    Write-Host "✅ Total Proxies: $($response.totalProxies)" -ForegroundColor Green
    Write-Host "✅ Working Proxies: $($response.workingProxies)" -ForegroundColor Green
    
    if ($response.workingProxies -gt 0) {
        Write-Host ""
        Write-Host "Top 5 Fastest Proxies:" -ForegroundColor Yellow
        $response.topProxies | ForEach-Object {
            Write-Host "  - $($_.url) ($($_.avgResponseTime)ms, $($_.successRate)% success)" -ForegroundColor White
        }
    } else {
        Write-Host "⚠️  No working proxies found yet" -ForegroundColor Yellow
        Write-Host "   This is normal for free proxies (20-40% success rate)" -ForegroundColor Yellow
        Write-Host "   Wait for next test cycle or trigger manual refresh" -ForegroundColor Yellow
    }
} else {
    Write-Host "❌ Proxy Manager: DISABLED" -ForegroundColor Red
}

Write-Host ""
Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
