@echo off
title On-Farm Desktop Application

:: Purana process band karo agar port 3789 par atka ho
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3789"') do (
    taskkill /F /PID %%a >nul 2>&1
)

cd /d "%~dp0client"
if exist "node_modules\electron\dist\electron.exe" (
    start "" "node_modules\electron\dist\electron.exe" electron-main.js
) else (
    npm run app
)
