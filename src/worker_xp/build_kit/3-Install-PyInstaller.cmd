@echo off
cd /d "%~dp0"
title 3. Offline Install PyInstaller 3.2.1
echo ========================================================
echo   [3/3] Offline Installing PyInstaller 3.2.1 and Deps
echo ========================================================
echo.

set PY_CMD=python
python --version >nul 2>&1
if errorlevel 1 goto :find_py34
goto :run_pip

:find_py34
if exist "C:\Python34\python.exe" (
    set "PY_CMD=C:\Python34\python.exe"
    goto :run_pip
)
if exist "C:\Python27\python.exe" (
    set "PY_CMD=C:\Python27\python.exe"
    goto :run_pip
)
echo [ERROR] Python was not found in PATH or C:\Python34\python.exe!
echo [TIP] Please ensure Step 1 (Python 3.4.4 setup) was completed.
pause
exit /b 1

:run_pip
echo [INFO] Using Python: %PY_CMD%
echo [INFO] Running offline pip install from local build_kit...
"%PY_CMD%" -m pip install --no-index --find-links="%~dp0." -r "%~dp0requirements-xp.txt"
if errorlevel 1 (
    echo.
    echo [ERROR] Offline pip install failed!
    pause
    exit /b 1
)

echo.
echo ========================================================
echo [SUCCESS] PyInstaller 3.2.1 installed successfully!
echo ========================================================
echo.
pause
