@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found.
  echo Please install the LTS version from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

echo Starting A3...
echo Local:  http://127.0.0.1:3213
echo Keep this window open while playing.
echo.
node server.js
pause
