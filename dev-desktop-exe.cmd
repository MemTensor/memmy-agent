@echo off
rem Launch Memmy desktop dev stack against the installed exe data home.
rem Data: config / memory sqlite / workspace live in the exe runtime home
rem (auto-detected, override with MEMMY_EXE_HOME).
setlocal
cd /d "%~dp0"
if errorlevel 1 (
  echo [dev] Failed to enter project directory: %~dp0
  pause
  exit /b 1
)

echo [dev] Starting Memmy desktop dev (exe data home) ...
call npm run dev:desktop:exe
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo [dev] Exited with code %EXITCODE%. See log above.
  pause
)
exit /b %EXITCODE%
