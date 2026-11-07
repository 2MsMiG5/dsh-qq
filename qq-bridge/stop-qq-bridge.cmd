@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ============================================================
rem  Stop qq-bridge for good.
rem
rem  Killing the node process alone is not enough when the bridge
rem  was started via start.bat / start-dsh-desktop.cmd: that batch
rem  file is a supervisor loop and re-launches the bridge 5 s
rem  after it exits. This stops the supervisor too, removes the
rem  single-instance lock, and verifies nothing came back.
rem
rem  ASCII-only on purpose (non-ASCII bytes break .bat under
rem  non-UTF-8 console code pages).
rem ============================================================

echo [qq-bridge] stopping bridge and its supervisor ...
node stop-qq-bridge.mjs
if errorlevel 1 (
    echo [qq-bridge] WARNING: something is still running - see the list above.
    pause
    exit /b 1
)
echo [qq-bridge] stopped.
pause
