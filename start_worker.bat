@echo off
chcp 65001 >nul
title phoneApp - 执行端 (Worker PC-01)
cd /d %~dp0
node src/worker/worker.js
pause
