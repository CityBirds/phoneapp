@echo off
setlocal enabledelayedexpansion

title phoneApp - Win32/XP Worker
cd /d "%~dp0"

rem ============================================================
rem   Windows XP (Win32) Standalone Worker Launcher
rem ============================================================

rem set "COORDINATOR=http://192.168.1.183:3001"

set "EXE_PATH="
if exist "src\worker_xp\dist\worker_xp\worker_xp.exe" (
  set "EXE_PATH=src\worker_xp\dist\worker_xp\worker_xp.exe"
) else if exist "dist\worker_xp\worker_xp.exe" (
  set "EXE_PATH=dist\worker_xp\worker_xp.exe"
) else if exist "src\worker_xp\dist\worker_xp.exe" (
  set "EXE_PATH=src\worker_xp\dist\worker_xp.exe"
) else if exist "worker_xp.exe" (
  set "EXE_PATH=worker_xp.exe"
)

if defined EXE_PATH (
  echo [XP Worker] Found worker_xp.exe: !EXE_PATH!
  echo [XP Worker] Starting standalone executable...
  if defined COORDINATOR (
    "!EXE_PATH!" --server "%COORDINATOR%"
  ) else (
    "!EXE_PATH!"
  )
  set "EXE_EXIT=!errorlevel!"
  if !EXE_EXIT! neq 0 (
    echo.
    echo [ERROR] worker_xp.exe exited with code: !EXE_EXIT!
  )
  goto :end
)

set "PY_CMD=python"
python --version >nul 2>&1
if errorlevel 1 (
  if exist "C:\Python34\python.exe" (
    set "PY_CMD=C:\Python34\python.exe"
  ) else if exist "C:\Python27\python.exe" (
    set "PY_CMD=C:\Python27\python.exe"
  ) else (
    echo.
    echo [ERROR] Python environment not found and worker_xp.exe not found.
    echo [TIP] For Windows XP, please run setup_xp_env.cmd or build_xp.bat.
    echo.
    pause
    exit /b 1
  )
)

echo [XP Worker] Starting XP worker via Python source (!PY_CMD!) ...
if defined COORDINATOR (
  echo [XP Worker] Coordinator: %COORDINATOR%
  "!PY_CMD!" src\worker_xp\worker_xp.py --server "%COORDINATOR%"
) else (
  "!PY_CMD!" src\worker_xp\worker_xp.py
)
set "PY_EXIT=!errorlevel!"
if !PY_EXIT! neq 0 (
  echo.
  echo [ERROR] Python worker exited with code: !PY_EXIT!
)

:end
echo.
pause

