@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

docker compose down
if errorlevel 1 (
  echo 错误：Memory 服务停止失败。
  pause
  exit /b 1
)

echo Memory 服务已停止，数据卷已保留。
pause
