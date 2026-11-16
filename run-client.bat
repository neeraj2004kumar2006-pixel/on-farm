@echo off
title On-Farm Secure Desktop Runner
color 0A
echo.
echo ======================================================
echo    ON-FARM SECURE DESKTOP AUTOMATION RUNNER
echo ======================================================
echo.

cd /d "%~dp0client"

:: Purana server band karo agar port 3789 par chal raha ho
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3789"') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo Opening Desktop Control Panel...
start "" "http://localhost:3789"

node runner.js
pause
