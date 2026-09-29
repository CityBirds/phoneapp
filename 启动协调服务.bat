@echo off
chcp 65001 >nul
title phoneApp - 协调服务端 (Port 3000)
echo ====================================================
echo [版本升级与重启说明]
echo 每次拉取新代码或功能升级后，必须关闭旧服务控制台窗口，
echo 并重新执行本脚本启动 Node.js 协调服务进程。
echo 目的：注册最新 API 路由（如 /api/published-bundles）并更新配置。
echo ====================================================
cd /d %~dp0
node src/backend/server.js
pause
