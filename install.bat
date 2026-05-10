@echo off
REM Labs Wallet — install + launch script for Windows.
REM Use this until the GitHub Actions build is producing signed installers.
REM
REM Requirements:
REM   - Node.js 20.x (https://nodejs.org)
REM
REM Usage:
REM   install.bat              install dependencies and launch
REM   install.bat --build      install + build a local NSIS .exe installer
REM   install.bat --install    install only

setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

echo.
echo === Labs Wallet : install helper ===
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [x] Node.js is required. Install Node 20 from https://nodejs.org and retry.
    exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
    echo [x] npm is required (ships with Node.js).
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo [v] Node !NODE_VER!

set MODE=%1
if "%MODE%"=="" set MODE=run

if not exist node_modules (
    echo Installing dependencies...
    if exist package-lock.json (
        call npm ci
        if errorlevel 1 call npm install
    ) else (
        call npm install
    )
    if errorlevel 1 (
        echo [x] npm install failed
        exit /b 2
    )
    echo [v] dependencies installed
)

if /I "%MODE%"=="--install" (
    echo [v] install only - done
    exit /b 0
)

if /I "%MODE%"=="--build" (
    echo Building NSIS installer...
    call npm run build:win
    if errorlevel 1 (
        echo [x] build:win failed
        exit /b 3
    )
    echo [v] installer built - see .\dist\
    exit /b 0
)

echo Launching Labs Wallet (dev mode)...
call npm start
exit /b %errorlevel%
