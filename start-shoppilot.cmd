@echo off
rem ===========================================================================
rem ShopPilot launcher - source mode, loads the latest build in apps\desktop\out
rem
rem DO NOT launch node_modules\electron\dist\electron.exe directly.
rem That path lives inside the pnpm junction tree:
rem   node_modules\electron  ->  node_modules\.pnpm\electron@44.7.2\node_modules\electron
rem Measured 2026-10-18: Electron started from that pnpm path - via the junction or via
rem the .pnpm real path - dies during Chromium init with 0x80000003 (STATUS_BREAKPOINT)
rem and prints nothing at all. A byte-for-byte identical runtime (all 74 files checked
rem with SHA-256) copied to a plain directory starts fine; the trigger is neither
rem non-ASCII characters, nor "node_modules" in the path, nor characters such as @.
rem Therefore this script keeps an independent runtime copy in sync with the Electron
rem version installed under node_modules, and always launches from that copy.
rem
rem Evidence: artifacts\restart-20261018-2331\RESTART-ATTEMPT-20261018-2331.md
rem
rem Runtime only, no launch:  set SHOPILOT_NO_LAUNCH=1
rem ===========================================================================
setlocal
rem Strip ELECTRON_RUN_AS_NODE: Electron hosts such as DSH export it to their children,
rem which would degrade electron.exe into plain Node and make it exit immediately.
rem Same rule as tools\acceptance\app-launch.js childEnv().
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"

set "SHOPILOT_RUNTIME=D:\ShopPilot-runtime"
set "SRC=%~dp0node_modules\electron\dist"

if not exist "%SRC%\electron.exe" goto no_source

rem Sync only when the runtime copy is missing or carries a different Electron version.
if not exist "%SHOPILOT_RUNTIME%\electron.exe" goto do_sync
fc /b "%SRC%\version" "%SHOPILOT_RUNTIME%\version" >nul 2>&1
if errorlevel 1 goto do_sync
goto launch

:do_sync
rem A running instance holds the runtime's electron.exe; deleting it would break it.
tasklist /fi "imagename eq electron.exe" 2>nul | find /i "electron.exe" >nul
if not errorlevel 1 goto sync_skipped
echo [ShopPilot] Syncing runtime to "%SHOPILOT_RUNTIME%"
if exist "%SHOPILOT_RUNTIME%" rmdir /s /q "%SHOPILOT_RUNTIME%" 2>nul
robocopy "%SRC%" "%SHOPILOT_RUNTIME%" /e /nfl /ndl /njh /njs /nc /ns /np >nul
if not exist "%SHOPILOT_RUNTIME%\electron.exe" goto sync_failed
goto launch

:sync_skipped
echo [ShopPilot] An Electron instance is running; skipping runtime sync.
goto launch

:launch
if "%SHOPILOT_NO_LAUNCH%"=="1" goto ready_only
echo [ShopPilot] Starting ShopPilot from "%SHOPILOT_RUNTIME%\electron.exe"
start "ShopPilot" "%SHOPILOT_RUNTIME%\electron.exe" .
exit /b 0

:ready_only
echo [ShopPilot] Runtime ready at "%SHOPILOT_RUNTIME%" - not launched
exit /b 0

:no_source
echo [ShopPilot] Missing "%SRC%". Run "pnpm install" in the repo root first.
pause
exit /b 1

:sync_failed
echo [ShopPilot] Runtime sync failed. Check disk space and permissions.
pause
exit /b 1
