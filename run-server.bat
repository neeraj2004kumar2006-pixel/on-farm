@echo off
title On-Farm Backend Server & Admin Panel
color 0B
echo.
echo ======================================================
echo    ON-FARM SAAS CLOUD BACKEND & ADMIN PANEL
echo ======================================================
echo.

cd /d "%~dp0server"

:: Purana server band karo agar port 4000 par chal raha ho
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4000"') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo Starting backend server on port 4000...
start "" "http://localhost:4000/api/health"
start "" "%~dp0admin\index.html"

node server.js
pause
