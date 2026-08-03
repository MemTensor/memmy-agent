@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

docker info >nul 2>&1
if errorlevel 1 (
  echo 错误：Docker Desktop 未运行，或找不到 Docker CLI。
  pause
  exit /b 1
)

docker compose up -d
if errorlevel 1 (
  echo 错误：Memory 服务启动失败。
  pause
  exit /b 1
)

docker compose ps
echo.
echo Memory 地址：http://127.0.0.1:18960
pause
