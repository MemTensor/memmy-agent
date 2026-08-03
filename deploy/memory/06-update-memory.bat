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

echo 正在从 WSL 源码重建 memmy-memory:local 镜像...
wsl.exe -u root --cd /root/memmy-agent docker build -f Memory/Dockerfile -t memmy-memory:local .
if errorlevel 1 (
  echo 错误：镜像重建失败，请检查默认 WSL 发行版和源码路径。
  pause
  exit /b 1
)

docker compose up -d --force-recreate
if errorlevel 1 (
  echo 错误：更新后的容器启动失败。
  pause
  exit /b 1
)

docker compose ps
echo 更新完成，数据卷已保留。
pause
