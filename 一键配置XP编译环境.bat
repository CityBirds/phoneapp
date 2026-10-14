@echo off
title Setup XP Build Environment
cd /d "%~dp0"
echo ============================================================
echo   Setting Up Windows XP Build Environment (Python 3.4.4)
echo ============================================================
echo.
call "%~dp0src\worker_xp\setup_xp_env.cmd"
echo.
echo Setup process exited with code: %errorlevel%
pause
