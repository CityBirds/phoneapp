@echo off
title Build Standalone XP Worker Package
cd /d "%~dp0"
echo ============================================================
echo   Building Windows XP (Win32) Standalone Worker Package
echo ============================================================
echo.
call "%~dp0src\worker_xp\build_xp.bat"
echo.
echo Build process exited with code: %errorlevel%
pause
