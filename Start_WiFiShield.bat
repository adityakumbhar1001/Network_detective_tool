@echo off
rem Starts the WiFiShield backend and dashboard, then opens the dashboard.
rem Close the two "WiFiShield" windows to stop them.
cd /d "%~dp0"
where npm >nul 2>nul || (echo Node.js is not installed: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing packages, first run only...
  call npm install || (pause & exit /b 1)
)
start "WiFiShield backend" cmd /k npm run server
start "WiFiShield dashboard" cmd /k npm run dev
echo Waiting for the dashboard to start...
timeout /t 6 /nobreak >nul
start "" http://localhost:5173
