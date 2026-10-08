@echo off
chcp 65001 >nul
title phoneApp - Worker
cd /d "%~dp0"

rem ============================================================
rem  Worker launcher (multi-worker LAN access, 2026-10-07)
rem
rem  Local identity (workerId + access secret) is generated once and
rem  stored in worker_config.local.json; it must NOT be copied to another PC.
rem
rem  To connect to the coordinator PC:
rem    1) first time : run  配置执行端接入.bat  and enter the coordinator LAN address
rem    2) per launch : uncomment COORDINATOR below with http://<coordinator-ip>:3001
rem
rem  3001 is the coordinator's worker access port, NOT the phone port 3000.
rem  Never publish it through a tunnel.
rem ============================================================

rem set "COORDINATOR=http://192.168.1.183:3001"

if defined COORDINATOR (
  echo [worker] using coordinator: %COORDINATOR%
  node src\worker\worker.js --server "%COORDINATOR%"
) else (
  node src\worker\worker.js
)

pause
