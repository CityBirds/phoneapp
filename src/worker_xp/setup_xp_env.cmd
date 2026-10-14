@echo off
cd /d "%~dp0"
title Windows XP Build Environment Setup
echo ========================================================
echo   Windows XP Python 3.4 + PyWin32 + PyInstaller Setup
echo ========================================================
echo.
echo Step 1: Install Python 3.4.4 (x86)
call "%~dp0build_kit\1-Install-Python34.cmd"

echo Step 2: Install PyWin32 for Python 3.4
call "%~dp0build_kit\2-Install-PyWin32.cmd"

echo Step 3: Offline install PyInstaller 3.2.1 and dependencies
call "%~dp0build_kit\3-Install-PyInstaller.cmd"

echo.
echo ========================================================
echo Setup completed! Starting standalone packaging now...
echo ========================================================
echo.
call "%~dp0build_xp.bat"
echo.
echo All steps finished. Exited with code: %errorlevel%
pause
