@echo off
echo Restarting YT Radio Backend...
echo.

REM Kill existing backend processes
taskkill /F /FI "WINDOWTITLE eq YT Radio Backend*" 2>nul
timeout /t 2 /nobreak >nul

REM Start backend
echo Starting backend...
start "YT Radio Backend" node backend/server.js

echo.
echo Backend restarted!
echo Dashboard: http://localhost:3000
echo.
pause
