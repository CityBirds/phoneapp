@echo off
setlocal enabledelayedexpansion
title phoneApp Execution Worker Diagnostic Check (Win32/XP)
cd /d "%~dp0"

echo ====================================================
echo   phoneApp Worker Diagnostic Self-Check (Diagnose)
echo ====================================================

if exist "%~dp0worker_xp.exe" (
  "%~dp0worker_xp.exe" --diagnose
  goto :finish
)

if exist "%~dp0dist\worker_xp\worker_xp.exe" (
  "%~dp0dist\worker_xp\worker_xp.exe" --diagnose
  goto :finish
)

python --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] Neither standalone worker_xp.exe nor Python was found.
  echo.
  pause
  exit /b 1
)

python "%~dp0worker_xp.py" --diagnose

:finish
echo.
pause
