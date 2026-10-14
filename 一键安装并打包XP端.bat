@echo off
title Setup and Build XP Worker
cd /d "%~dp0"
echo ============================================================
echo   One-Click Setup and Build for Windows XP (Win32)
echo ============================================================
echo.
call "%~dp0src\worker_xp\setup_xp_env.cmd"
echo.
echo Process exited with code: %errorlevel%
pause
