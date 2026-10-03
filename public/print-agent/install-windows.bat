@echo off
rem StockSync label print agent installer for Windows (run once on the store PC)
setlocal
set "SITE=https://jejubaseball.com"
set "DIR=%USERPROFILE%\StockSyncPrint"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [1/4] Node.js is required but was not found.
  where winget >nul 2>nul
  if errorlevel 1 (
    echo winget is not available on this PC.
    echo Please install Node.js LTS manually from https://nodejs.org , then run this file again.
    start "" https://nodejs.org/en/download
    pause
    exit /b 1
  )
  echo Installing Node.js LTS with winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo Node.js was installed. CLOSE this window and run install-windows.bat once more.
  pause
  exit /b 0
)

echo [1/4] Node.js found.
if not exist "%DIR%" mkdir "%DIR%"
echo [2/4] Downloading agent from %SITE% ...
powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing '%SITE%/static/print-agent/agent.mjs' -OutFile '%DIR%\agent.mjs'"
if errorlevel 1 (
  echo Download failed. Check the internet connection and try again.
  pause
  exit /b 1
)

> "%DIR%\start.bat" echo @echo off
>> "%DIR%\start.bat" echo cd /d "%DIR%"
>> "%DIR%\start.bat" echo node agent.mjs
rem For troubleshooting: shows errors in a window
> "%DIR%\start-visible.bat" echo @echo off
>> "%DIR%\start-visible.bat" echo cd /d "%DIR%"
>> "%DIR%\start-visible.bat" echo node agent.mjs
>> "%DIR%\start-visible.bat" echo pause

echo [3/4] Registering auto start at Windows login...
> "%DIR%\hidden-start.vbs" echo CreateObject("Wscript.Shell").Run """%DIR%\start.bat""", 0, False
copy /y "%DIR%\hidden-start.vbs" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\StockSyncPrint.vbs" >nul

rem Stop an older copy that may still be running, then start the new one
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | Where-Object { $_.CommandLine -like '*agent.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul
echo [4/4] Starting the agent and checking it...
wscript "%DIR%\hidden-start.vbs"
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "try { $r = Invoke-RestMethod http://127.0.0.1:9101/status -TimeoutSec 5; Write-Host ('OK: agent v' + $r.version + ' is running.') -ForegroundColor Green } catch { Write-Host 'NOT RUNNING. Double-click start-visible.bat in the folder below to see the error.' -ForegroundColor Red }"
echo Folder: %DIR%
echo.
echo Open the Labels page in StockSync with Chrome or Edge and press the printer button.
echo (If Chrome asks to allow access to devices on your local network, press Allow.)
pause
