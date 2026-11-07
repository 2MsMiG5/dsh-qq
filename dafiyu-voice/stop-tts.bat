@echo off
rem ===========================================================
rem  dafiyu TTS local service - stop
rem ===========================================================
setlocal
set "ROOT=%~dp0"
set "PIDFILE=%ROOT%logs\tts.pid"

if not exist "%PIDFILE%" goto :byname

set /p THEPID=<"%PIDFILE%"
echo Stopping TTS (pid %THEPID%) ...
taskkill /PID %THEPID% /T /F >nul 2>&1
if errorlevel 1 goto :byname
del /q "%PIDFILE%" >nul 2>&1
echo Stopped.
goto :eof

:byname
echo No pid file (or stale) - stopping any dafiyu server.py process ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$k=0; Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*dafiyu-voice*server.py*' } | ForEach-Object { Write-Host ('killing pid ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $k++ }; if ($k -eq 0) { Write-Host 'TTS not running' }"
del /q "%PIDFILE%" >nul 2>&1
goto :eof
