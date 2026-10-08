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

rem INTERNAL_BIND 决定“执行端接入口”监听哪些网卡：
rem   0.0.0.0     = 允许局域网内其它电脑的执行端接入（多机部署需要，本文件默认）
rem   <本机局域网IP> = 只监听指定网卡（更严格，推荐固定 IP 的协调机使用）
rem   127.0.0.1   = 只允许本机执行端（不需要远程执行端时使用）
rem 注意：该端口绝不可发布到公网隧道；远程接入的安全性由执行端身份凭据保证。
if not defined INTERNAL_BIND set "INTERNAL_BIND=0.0.0.0"
echo 执行端接入口监听地址: %INTERNAL_BIND%:%INTERNAL_PORT%

rem 首次接入登记策略：
rem   first-time = 允许执行端首次自动登记（默认）
rem   closed     = 只允许管理员预先登记过的执行端接入（更严格）
if not defined WORKER_REGISTRATION set "WORKER_REGISTRATION=first-time"

cd /d "%~dp0"
node src\backend\server.js
pause
