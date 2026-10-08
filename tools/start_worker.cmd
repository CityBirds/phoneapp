@echo off
rem ============================================================
rem  PhoneApp Worker (execution terminal) - talks to internal port
rem  Usage: start_worker.cmd
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0.."
if not exist "data\logs" mkdir "data\logs"

set WORKER_PORT=3001

echo Starting execution worker (API -> http://127.0.0.1:3001) ...
start "phoneApp-worker" /min cmd /c "node src\worker\worker.js >> data\logs\worker.log 2>&1"
echo   Worker started. Log: data\logs\worker.log
echo.