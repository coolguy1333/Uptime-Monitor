@echo off
REM Quick start on Windows: double-click this file.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ is required. Download it from https://nodejs.org
  pause
  exit /b 1
)
node server.js
pause
