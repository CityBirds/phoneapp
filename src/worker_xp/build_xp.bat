@echo off
setlocal enabledelayedexpansion

rem ============================================================
rem   Windows XP (Win32) PyInstaller onedir Build Script
rem   Target: Windows XP SP3 (x86) / Python 3.4.4 (32-bit x86)
rem ============================================================

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo [1/4] Checking Python environment and architecture...

if exist "C:\Python34\python.exe" (
    set "PATH=C:\Python34;C:\Python34\Scripts;!PATH!"
)
if exist "C:\Python27\python.exe" (
    set "PATH=C:\Python27;C:\Python27\Scripts;!PATH!"
)

set "PY_CMD=python"
python --version >nul 2>&1
if errorlevel 1 goto :detect_python_fallback
goto :python_found

:detect_python_fallback
if exist "C:\Python34\python.exe" (
    set "PY_CMD=C:\Python34\python.exe"
    goto :python_found
)
if exist "C:\Python27\python.exe" (
    set "PY_CMD=C:\Python27\python.exe"
    goto :python_found
)
goto :err_no_python

:python_found
echo [INFO] Using Python interpreter: !PY_CMD!
"!PY_CMD!" --version

rem Check for 32-bit architecture
"!PY_CMD!" -c "import struct, sys; sys.exit(0 if struct.calcsize('P') == 4 else 1)" >nul 2>&1
if errorlevel 1 goto :err_arch_64

echo [2/4] Checking PyInstaller...
"!PY_CMD!" -c "import PyInstaller" >nul 2>&1
if errorlevel 1 goto :install_pyinstaller
goto :pyinstaller_ready

:install_pyinstaller
echo [INFO] PyInstaller not detected. Installing PyInstaller 3.2.1...
if exist "%SCRIPT_DIR%build_kit\PyInstaller-3.2.1.tar.bz2" goto :install_offline
goto :install_online

:install_offline
echo [INFO] Installing from offline build_kit directory...
"!PY_CMD!" -m pip install --no-index --find-links="%SCRIPT_DIR%build_kit" -r "%SCRIPT_DIR%build_kit\requirements-xp.txt"
if errorlevel 1 goto :err_install_pyinstaller
goto :pyinstaller_ready

:install_online
echo [INFO] Installing PyInstaller from PyPI...
"!PY_CMD!" -m pip install "PyInstaller==3.2.1"
if errorlevel 1 goto :err_install_pyinstaller
goto :pyinstaller_ready

:pyinstaller_ready
echo [INFO] PyInstaller is ready.

echo [3/4] Cleaning previous build artifacts...
if exist "dist" rd /s /q "dist"
if exist "build" rd /s /q "build"

echo [4/4] Building standalone onedir package using worker_xp.spec...
set "BUILD_OK=0"
"!PY_CMD!" -m PyInstaller --noconfirm --clean "worker_xp.spec"
if not errorlevel 1 set "BUILD_OK=1"

if "!BUILD_OK!"=="0" (
    if exist "C:\Python34\Scripts\pyinstaller.exe" (
        echo [INFO] Retrying with C:\Python34\Scripts\pyinstaller.exe ...
        "C:\Python34\Scripts\pyinstaller.exe" --noconfirm --clean "worker_xp.spec"
        if not errorlevel 1 set "BUILD_OK=1"
    )
)

if "!BUILD_OK!"=="0" goto :err_build_failed

rem Copy release scripts and default config into dist\worker_xp
if exist "dist\worker_xp" (
    copy /y "StartWorker.cmd" "dist\worker_xp\" >nul
    copy /y "ConfigureWorker.cmd" "dist\worker_xp\" >nul
    copy /y "DiagnoseWorker.cmd" "dist\worker_xp\" >nul
    copy /y "coordinator.defaults.json" "dist\worker_xp\" >nul
    copy /y "version.json" "dist\worker_xp" >nul
    for %%f in ("README*.md") do copy /y "%%f" "dist\worker_xp\" >nul

    rem Also mirror output to root dist\worker_xp for easy access
    if not exist "%SCRIPT_DIR%..\..\dist\worker_xp" mkdir "%SCRIPT_DIR%..\..\dist\worker_xp" >nul 2>&1
    xcopy /e /y /q "%SCRIPT_DIR%dist\worker_xp" "%SCRIPT_DIR%..\..\dist\worker_xp\" >nul 2>&1
)

echo.
echo ============================================================
echo [SUCCESS] Windows XP (Win32) Standalone Package Completed!
echo Output Location: %SCRIPT_DIR%dist\worker_xp
echo Mirror Location: %SCRIPT_DIR%..\..\dist\worker_xp
echo ============================================================
echo.
echo Opening output directory in Windows Explorer...
start explorer "%SCRIPT_DIR%dist\worker_xp"
pause
exit /b 0

:err_no_python
echo.
echo ============================================================
echo [ERROR] Python environment not found!
echo [TIP] Please ensure Python 3.4.4 [32-bit] is installed.
echo [TIP] Run: setup_xp_env.cmd or build_kit\1-Install-Python34.cmd
echo ============================================================
echo.
pause
exit /b 1

:err_arch_64
echo.
echo ============================================================
echo [CRITICAL ERROR] Detected 64-bit Python!
echo [ERROR] Windows XP requires 32-bit Python [3.4.4 x86].
echo [TIP] Please uninstall 64-bit Python and install 32-bit.
echo ============================================================
echo.
pause
exit /b 1

:err_install_pyinstaller
echo.
echo ============================================================
echo [ERROR] Failed to install PyInstaller 3.2.1.
echo [TIP] Please run: build_kit\3-Install-PyInstaller.cmd
echo ============================================================
echo.
pause
exit /b 1

:err_build_failed
echo.
echo ============================================================
echo [ERROR] PyInstaller build failed.
echo [TIP] Please review the error log above.
echo ============================================================
echo.
pause
exit /b 1
