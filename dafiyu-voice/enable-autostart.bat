@echo off
rem 开启「登录后自动启动大肥鱼 TTS 服务」：往当前用户的启动文件夹放一个入口。
rem 关掉：disable-autostart.bat
rem 注意：服务常驻会占约 5GB 显存，玩游戏前可先 stop-tts.bat。
setlocal
set "ROOT=%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "ENTRY=%STARTUP%\dafiyu-tts.cmd"
if not exist "%STARTUP%" mkdir "%STARTUP%"
> "%ENTRY%" (
  echo @echo off
  echo call "%ROOT%start-tts.bat"
)
if exist "%ENTRY%" (
  echo [OK] autostart enabled: "%ENTRY%"
  echo      下次登录 Windows 后会自动在后台加载大肥鱼 TTS 服务（约 1~2 分钟可用）。
) else (
  echo [FAIL] 写入启动项失败：%ENTRY%
)
endlocal
