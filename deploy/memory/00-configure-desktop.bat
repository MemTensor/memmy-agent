@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

set "TOKEN="
for /f "tokens=1,* delims==" %%A in ('findstr /b "MEMMY_MEMORY_TOKEN=" ".env" 2^>nul') do set "TOKEN=%%B"

if not defined TOKEN (
  echo 错误：%CD%\.env 中没有 MEMMY_MEMORY_TOKEN
  pause
  exit /b 1
)

set "CONFIG_DIR=%USERPROFILE%\.memmy"
set "CONFIG_FILE=%CONFIG_DIR%\config.yaml"

if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"

if exist "%CONFIG_FILE%" goto existing_config

>"%CONFIG_FILE%" (
  echo memmyMemory:
  echo   storage:
  echo     runtime: remote
  echo     endpoint: http://127.0.0.1:18960
  echo     token: "%TOKEN%"
)

echo 已创建：%CONFIG_FILE%
start "" notepad.exe "%CONFIG_FILE%"
pause
exit /b 0

:existing_config
echo %TOKEN%| clip.exe
echo 已存在配置，未覆盖：%CONFIG_FILE%
echo Memory token 已复制到剪贴板。
echo 请确认 memmyMemory.storage 包含：
echo   runtime: remote
echo   endpoint: http://127.0.0.1:18960
echo   token: 当前剪贴板中的 token
start "" notepad.exe "%CONFIG_FILE%"
pause
