@echo off
chcp 65001 >nul
title 手机发货证书与装箱清单任务系统 - 一键启动
echo ====================================================
echo 正在启动 协调服务 (Coordination Service)...
echo ====================================================
start "phoneApp - 协调服务端 (Port 3000)" cmd /k "chcp 65001 >nul && cd /d %~dp0 && node src/backend/server.js"

timeout /t 2 /nobreak >nul

echo ====================================================
echo 正在启动 执行端 (Execution Worker)...
echo ====================================================
start "phoneApp - 执行端 (Worker PC-01)" cmd /k "chcp 65001 >nul && cd /d %~dp0 && node src/worker/worker.js"

timeout /t 1 /nobreak >nul

echo ====================================================
echo 正在打开前端页面: http://localhost:3000/frontend
echo ====================================================
start http://localhost:3000/frontend
exit
