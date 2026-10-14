@echo off
cd /d "%~dp0"
title 1. Install Python 3.4.4 (x86)
echo ========================================================
echo   [1/3] Installing Python 3.4.4 (32-bit x86) for XP
echo ========================================================
echo.
if not exist "%~dp0python-3.4.4.msi" (
    echo [ERROR] python-3.4.4.msi not found!
    pause
    exit /b 1
)

echo [TIP] During setup wizard, please click Next until Finished.
echo Starting installer...
msiexec /i "%~dp0python-3.4.4.msi"
echo.
echo Python 3.4.4 setup wizard finished.
echo.
pause
