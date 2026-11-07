@echo off
rem 取消「登录后自动启动大肥鱼 TTS 服务」（不影响当前正在运行的服务）。
setlocal
set "ENTRY=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dafiyu-tts.cmd"
if exist "%ENTRY%" (
  del /q "%ENTRY%"
  echo [OK] autostart disabled.
) else (
  echo [INFO] autostart 本来就没开。
)
endlocal
