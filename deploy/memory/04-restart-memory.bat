@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

docker compose restart memory
if errorlevel 1 (
  echo 错误：Memory 服务重启失败。
  pause
  exit /b 1
)

docker compose ps
pause
