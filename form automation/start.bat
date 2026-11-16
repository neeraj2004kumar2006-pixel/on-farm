@echo off
title Farmer Form Automation
color 0A
echo.
echo ============================================
echo   FARMER FORM AUTOMATION
echo ============================================
echo.

:: Purana server band karo (agar chal raha ho)
echo Purana server band kar raha hai...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3789"') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo ============================================
echo  Control panel: http://localhost:3789
echo ============================================
echo  Automation apna Chrome window kholega.
echo  Usme login karein aur form select karein.
echo  Phir localhost:3789 pe START dabayein.
echo ============================================
echo.

node automation.js
pause
