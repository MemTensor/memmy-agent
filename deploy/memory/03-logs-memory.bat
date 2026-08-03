@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

echo 按 Ctrl+C 停止查看日志。
docker compose logs -f --tail 200 memory
