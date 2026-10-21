@echo off
chcp 65001 >nul
title phoneApp - 协调服务端 (Port 3000)
echo ====================================================
echo [版本升级与重启说明]
echo 每次拉取新代码或功能升级后，必须关闭旧服务控制台窗口，
echo 并重新执行本脚本启动 Node.js 协调服务进程。
echo 目的：注册最新 API 路由（如 /api/published-bundles）并更新配置。
echo ====================================================
set "PORT=3000"
set "INTERNAL_PORT=3001"
set "SKIP_SEED_TEMPLATES=1"

rem INTERNAL_BIND: 0.0.0.0 (default), 127.0.0.1, or LAN IP
if not defined INTERNAL_BIND set "INTERNAL_BIND=0.0.0.0"
echo 执行端接入口监听地址: %INTERNAL_BIND%:%INTERNAL_PORT%

rem WORKER_REGISTRATION: first-time (default) or closed
if not defined WORKER_REGISTRATION set "WORKER_REGISTRATION=first-time"

cd /d "%~dp0"
node src\backend\server.js
pause
