@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

docker compose ps
echo.
powershell.exe -NoProfile -Command "try { $h = Invoke-RestMethod -Uri 'http://127.0.0.1:18960/api/v1/health' -TimeoutSec 5; Write-Host ('健康检查：ok={0}，存储就绪={1}，向量引擎={2}' -f $h.ok, $h.storage.ready, $h.storage.vector) } catch { Write-Host ('健康检查失败：' + $_.Exception.Message); exit 1 }"
pause
