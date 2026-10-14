@echo off
setlocal enabledelayedexpansion
title phoneApp Execution Worker (Win32/XP)
cd /d "%~dp0"

echo ====================================================
echo   phoneApp Standalone Execution Worker (Win32/XP)
echo ====================================================

if exist "%~dp0worker_xp.exe" (
  echo [INFO] Starting bundled standalone worker_xp.exe ...
  "%~dp0worker_xp.exe"
  set "EXIT_CODE=!errorlevel!"
  if !EXIT_CODE! neq 0 (
    echo.
    echo [ERROR] Execution terminated with exit code: !EXIT_CODE!
  )
  goto :finish
)

if exist "%~dp0dist\worker_xp\worker_xp.exe" (
  echo [INFO] Starting onedir dist\worker_xp\worker_xp.exe ...
  "%~dp0dist\worker_xp\worker_xp.exe"
  set "EXIT_CODE=!errorlevel!"
  if !EXIT_CODE! neq 0 (
    echo.
    echo [ERROR] Execution terminated with exit code: !EXIT_CODE!
  )
  goto :finish
)

python --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] Neither standalone worker_xp.exe nor Python was found.
  echo [TIP] For target Windows XP machines, please unzip the full prebuilt package.
  echo.
  pause
  exit /b 1
)

echo [INFO] Fallback: starting worker via Python source...
python "%~dp0worker_xp.py"
set "EXIT_CODE=%errorlevel%"
if %EXIT_CODE% neq 0 (
  echo.
  echo [ERROR] Python worker exited with code: %EXIT_CODE%
)

:finish
echo.
pause
