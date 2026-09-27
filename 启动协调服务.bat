@echo off
chcp 65001 >nul
title phoneApp - 协调服务端 (Port 3000)
cd /d %~dp0
node src/backend/server.js
pause
