@echo off
title Phoenix School Transport
color 0A
cd /d "%~dp0"

echo.
echo  ===================================================================
echo   Phoenix School Transport Management
echo  ===================================================================
echo.

REM ─── Step 1: Install Desktop App ────────────────────────────────────────────
echo [1/3] Setting up Operator Portal (Electron)...
cd /d "%~dp0desktop-app"
if not exist node_modules call npm install
echo       Done.
echo.

REM ─── Step 2: Launch Electron Desktop App ────────────────────────────────────
echo [2/3] Launching Operator Portal...
start "" cmd /c "cd /d "%~dp0desktop-app" && npx electron ."
echo       Electron window opening...
echo.

REM ─── Step 3: Start Admin Portal ─────────────────────────────────────────────
echo [3/3] Starting Admin Portal...
cd /d "%~dp0admin-portal"
if not exist node_modules call npm install
echo       Starting Vite dev server...
start "" cmd /c "cd /d "%~dp0admin-portal" && npx vite --open --port 5173"

echo.
echo  ===================================================================
echo   ALL SERVICES LAUNCHED
echo  ===================================================================
echo.
echo   Operator Portal:  Electron desktop window
echo   Admin Portal:     http://localhost:5173
echo.
echo   Close this window when done.
echo.
pause
