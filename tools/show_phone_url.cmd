@echo off
rem ============================================================
rem  Show the phone access URL (auto-built from tunnel.url + token)
rem  Usage: show_phone_url.cmd
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0.."

set "TUNNEL="
set "TOKEN="
if exist "data\tunnel.url" for /f "usebackq delims=" %%u in ("data\tunnel.url") do set "TUNNEL=%%u"
if exist "data\access_token.txt" for /f "usebackq delims=" %%t in ("data\access_token.txt") do set "TOKEN=%%t"

echo.
echo ============================================================
echo   Phone access info
echo ============================================================
echo.
if "%TUNNEL%"=="" (
  echo   [X] Tunnel URL not found. Run tools\start_tunnel.cmd first.
  echo       ^(the URL is written to data\tunnel.url^)
  goto :token
)
if "%TOKEN%"=="" (
  echo   [X] Access token not found in data\access_token.txt
  goto :done
)

echo   Step 1 - open this URL on the phone:
echo.
echo     %TUNNEL%/frontend/login.html
echo.
echo   Step 2 - enter this access token:
echo.
echo     %TOKEN%
echo.
echo   One-tap link (may be truncated by WeChat, prefer typing the URL):
echo.
echo     %TUNNEL%/frontend/index.html?k=%TOKEN%
echo.
echo   Also saved to: data\phone_access.txt
echo.
> "data\phone_access.txt" echo URL:   %TUNNEL%/frontend/login.html
>> "data\phone_access.txt" echo TOKEN: %TOKEN%
>> "data\phone_access.txt" echo LINK:  %TUNNEL%/frontend/index.html?k=%TOKEN%
goto :done

:token
echo   Access token (still valid): %TOKEN%
echo   Tunnel URL missing - cannot build the full link yet.

:done
echo ============================================================
echo.