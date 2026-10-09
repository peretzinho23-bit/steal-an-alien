@echo off
setlocal
cd /d "%~dp0"
title Steal an Alien - Discord Bot

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org
  pause
  exit /b 1
)

if not exist ".env" (
  echo Missing .env file. Copy .env.example to .env and put the bot token in it.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

:run
echo [%date% %time%] Starting the bot...
node --env-file=.env src/index.js
echo [%date% %time%] The bot stopped with exit code %errorlevel%. Restarting in 10 seconds. Close this window to stop it.
timeout /t 10 /nobreak >nul
goto run
