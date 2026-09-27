@echo off
chcp 65001 >nul
title phoneApp - 打开协调管理控制台
start http://localhost:3000/admin
echo 已在浏览器中打开协调服务管理控制台 (http://localhost:3000/admin)
