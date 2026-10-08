@echo off
rem ============================================================
rem  PhoneApp Coordinator Service
rem   - public port  : 3000  (phones; published by the tunnel)
rem   - internal port: 3001  (worker API only; loopback, never published)
rem  Usage: start_coordinator.cmd
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0.."
if not exist "data\logs" mkdir "data\logs"

set PORT=3000
set INTERNAL_PORT=3001
set SKIP_SEED_TEMPLATES=1

echo Stopping any process already listening on port 3000 / 3001 ...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /c:":3000 "') do (
  taskkill /PID %%p /F >nul 2>&1
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /c:":3001 "') do (
  taskkill /PID %%p /F >nul 2>&1
)
ping -n 2 127.0.0.1 >nul

echo Starting coordinator service in background ...
start "phoneApp-coordinator" /min cmd /c "node src\backend\server.js >> data\logs\coordinator.log 2>&1"

echo.
echo   Coordinator started.
echo   Public port  (tunnel target) : 3000
echo   Internal port (worker API)   : 3001  (loopback only)
echo   Admin console (local only)   : http://localhost:3000/admin
echo   Worker start command         : set WORKER_PORT=3001 ^&^& node src\worker\worker.js
echo   Log file                     : data\logs\coordinator.log
echo   Access token file            : data\access_token.txt
echo.