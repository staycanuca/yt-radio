@echo off
if "%BACKEND_PORT%"=="" set BACKEND_PORT=3000
if "%RADIO_API%"=="" set RADIO_API=http://localhost:8080

echo Starting YT Radio Backend...
node backend\server.js
