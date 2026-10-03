@echo off
rem StockSync label print agent installer for Windows (run once on the store PC)
setlocal
set "SITE=https://jejubaseball.com"
set "DIR=%USERPROFILE%\StockSyncPrint"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Installing Node.js LTS with winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo Node.js was installed. Close this window and run install-windows.bat once more.
  pause
  exit /b 0
)

if not exist "%DIR%" mkdir "%DIR%"
echo Downloading agent from %SITE% ...
powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing '%SITE%/static/print-agent/agent.mjs' -OutFile '%DIR%\agent.mjs'"
if errorlevel 1 (
  echo Download failed. Check the internet connection and try again.
  pause
  exit /b 1
)

> "%DIR%\start.bat" echo @echo off
>> "%DIR%\start.bat" echo cd /d "%DIR%"
>> "%DIR%\start.bat" echo node agent.mjs

rem Run automatically at Windows login, without a console window
> "%DIR%\hidden-start.vbs" echo CreateObject("Wscript.Shell").Run """%DIR%\start.bat""", 0, False
copy /y "%DIR%\hidden-start.vbs" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\StockSyncPrint.vbs" >nul

echo Starting the agent now...
wscript "%DIR%\hidden-start.vbs"
echo.
echo Done. The print agent runs in the background and starts automatically with Windows.
echo Open the Labels page in StockSync and press the printer button.
pause
