@echo off
chcp 65001 >nul
title phoneApp - 执行端 (Worker)
cd /d %~dp0

rem ============================================================
rem  执行端启动脚本（多执行端局域网接入整改 2026-10-07）
rem
rem  本机身份（workerId 与接入凭据）自动生成并保存到
rem  worker_config.local.json，重启后沿用，不需要手工维护。
rem
rem  连接协调服务电脑有两种方式：
rem   1) 首次接入：先运行  配置执行端接入.bat  填写协调电脑局域网地址；
rem   2) 单次指定：把下面 COORDINATOR 改成 http://<协调电脑IP>:3001
rem
rem  注意：3001 是协调服务的“执行端接入口”，不是手机对外端口 3000；
rem        隧道不发布这个端口。
rem ============================================================

rem 如需固定指定协调电脑地址，取消下一行注释并改成实际地址：
rem set COORDINATOR=http://192.168.1.10:3001

if defined COORDINATOR (
  echo [执行端] 使用脚本指定地址: %COORDINATOR%
  node src\worker\worker.js --server %COORDINATOR%
) else (
  node src\worker\worker.js
)

pause
