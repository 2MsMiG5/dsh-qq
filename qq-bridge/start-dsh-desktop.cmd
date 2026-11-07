@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ============================================================
rem  Use THIS script (not start.bat) when DSH runs as Desktop.
rem
rem  DSH Desktop boots with "--port 0", so it listens on a RANDOM
rem  port every launch. qq-bridge is a separate process and can
rem  only find DSH through config.json -> dsh.baseUrl, so the port
rem  must be re-synced before every bridge start.
rem
rem  Step 1: sync-dsh-port.mjs detects the live DSH web API port
rem          and rewrites dsh.baseUrl in config.json.
rem  Step 2: start.bat runs the bridge in daemon mode (auto-restart
rem          5 s after a crash).
rem
rem  ASCII-only on purpose: non-ASCII bytes in a .bat break under
rem  non-UTF-8 console code pages (same rule start.bat follows).
rem ============================================================

echo [qq-bridge] syncing DSH Desktop port ...
node sync-dsh-port.mjs
if errorlevel 1 (
    rem Not fatal: the bridge re-discovers the DSH port itself once DSH is up
    rem (bridge.js "DSH port auto-follow"), so just start it anyway.
    echo [qq-bridge] port sync failed for now - bridge will auto-detect the DSH port once DSH is up.
)

echo [qq-bridge] starting bridge ^(close this window to stop^) ...
call start.bat
