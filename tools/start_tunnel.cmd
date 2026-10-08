@echo off
rem ============================================================
rem  PhoneApp public tunnel (Cloudflare Quick Tunnel)
rem   - Publishes the PUBLIC port 3000 only (never 3001)
rem   - cloudflared log : data\logs\tunnel.log
rem   - public URL       : data\tunnel.url  (written by this script)
rem  Usage: start_tunnel.cmd
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0.."
if not exist "data\logs" mkdir "data\logs"

echo Stopping previous cloudflared ...
taskkill /IM cloudflared.exe /F >nul 2>&1
ping -n 2 127.0.0.1 >nul

echo Starting tunnel to http://127.0.0.1:3000 ...
start "phoneApp-tunnel" /min cmd /c ""%~dp0cloudflared.exe" tunnel --url http://127.0.0.1:3000 --no-autoupdate --logfile "data\logs\tunnel.log""

echo.
echo   Tunnel starting. Reading the public URL from the log ...
echo.
ping -n 12 127.0.0.1 >nul

for /f "delims=" %%u in ('powershell -NoProfile -Command "$m=(Select-String -Path ''data\logs\tunnel.log'' -Pattern ''https://[a-z0-9-]+\.trycloudflare\.com'' | Select-Object -First 1); if($m){$m.Matches[0].Value}"') do set "PUBURL=%%u"

if defined PUBURL (
  > "data\tunnel.url" echo %PUBURL%
  echo   ============================================
  echo    Public URL : %PUBURL%
  echo    Phone link : %PUBURL%/frontend/index.html?k=YOUR_TOKEN
  echo    Token file : data\access_token.txt
  echo   ============================================
) else (
  echo   URL not detected yet. Open data\logs\tunnel.log and look for "trycloudflare.com".
)
echo.