@echo off
chcp 65001 >nul
title phoneApp - Coordinator (Port 3000)
echo ====================================================
echo [Upgrade / restart notice]
echo After pulling new code or upgrading features, close the old
echo console window and run this script again to start the Node.js
echo coordinator process (registers the latest API routes).
echo ====================================================
set "PORT=3000"
set "INTERNAL_PORT=3001"
set "SKIP_SEED_TEMPLATES=1"

rem INTERNAL_BIND controls which interfaces the worker access port listens on:
rem   0.0.0.0        = allow worker PCs on the LAN (needed for multi-machine setups)
rem   <LAN IP>       = bind one specific interface (stricter, recommended with static IP)
rem   127.0.0.1      = local worker only
rem Never publish this port through a public tunnel; remote access is protected by
rem the per-worker access secret, not by the bind address.
if not defined INTERNAL_BIND set "INTERNAL_BIND=0.0.0.0"
echo Worker access port bind: %INTERNAL_BIND%:%INTERNAL_PORT%

rem WORKER_REGISTRATION: first-time (allow first auto-registration) or closed (pre-register only)
if not defined WORKER_REGISTRATION set "WORKER_REGISTRATION=first-time"

cd /d "%~dp0"
node src\backend\server.js
pause
