@echo off
rem ===========================================================
rem  dafiyu TTS local service - start (background on 127.0.0.1:3210)
rem  usage: start-tts.bat          start in background (hidden window)
rem         start-tts.bat --fg     run in foreground (Ctrl+C to stop)
rem ===========================================================
setlocal
set "ROOT=%~dp0"
set "PY=%ROOT%env\Scripts\python.exe"
set "PORT=3210"
if not exist "%ROOT%logs" mkdir "%ROOT%logs"
if not exist "%ROOT%tmp" mkdir "%ROOT%tmp"

if /I "%~1"=="--fg" goto foreground

rem -- already running? --
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:%PORT%/health' -TimeoutSec 2; if ($r.ok) { Write-Host 'TTS already running on port %PORT%'; exit 3 } } catch { }; exit 0"
if errorlevel 3 goto :eof

rem -- launch hidden background process --
echo Starting dafiyu TTS on 127.0.0.1:%PORT% ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath '%PY%' -ArgumentList 'server.py' -WorkingDirectory '%ROOT%' -WindowStyle Hidden -RedirectStandardOutput '%ROOT%logs\stdout.log' -RedirectStandardError '%ROOT%logs\stderr.log' -PassThru; Set-Content -Path '%ROOT%logs\tts.pid' -Value $p.Id -Encoding ascii; Write-Host ('pid=' + $p.Id)"

rem -- wait for /health (model load + warmup takes ~50s) --
powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline=(Get-Date).AddSeconds(300); while ((Get-Date) -lt $deadline) { try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:%PORT%/health' -TimeoutSec 2; Write-Host ('READY ' + ($r | ConvertTo-Json -Compress)); exit 0 } catch { Start-Sleep -Seconds 3 } }; Write-Host 'TIMEOUT waiting for /health - see logs\stderr.log'; exit 1"
goto :eof

:foreground
echo Foreground start, Ctrl+C to stop.
"%PY%" "%ROOT%server.py"
goto :eof
