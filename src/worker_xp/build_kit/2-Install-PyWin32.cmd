@echo off
cd /d "%~dp0"
title 2. Install PyWin32 for Python 3.4
echo ========================================================
echo   [2/3] Installing PyWin32 for Python 3.4 (32-bit x86)
echo ========================================================
echo.
if not exist "%~dp0pywin32-221.win32-py3.4.exe" (
    echo [ERROR] pywin32-221.win32-py3.4.exe not found!
    pause
    exit /b 1
)

echo Starting PyWin32 installer wizard...
"%~dp0pywin32-221.win32-py3.4.exe"
echo.
echo PyWin32 installation completed.
echo.
pause
