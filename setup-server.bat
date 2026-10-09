@echo off
setlocal
cd /d "%~dp0bot"
title Steal an Alien - Rebuild the server

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org
  pause
  exit /b 1
)

if not exist ".env" (
  echo Missing bot\.env file. Copy bot\.env.example to bot\.env and fill in the token and server id.
  pause
  exit /b 1
)

if not exist "node_modules" (
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

echo.
echo This DELETES every channel and every role except Owner, then builds the server from scratch.
echo You will be asked to type the server name to confirm.
echo.
call npm run setup
echo.
pause
