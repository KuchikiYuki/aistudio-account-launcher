@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title AI Studio Launcher - Keep this window open
pushd "%~dp0"
if errorlevel 1 goto directory_error
echo.
echo ============================================================
echo   AI Studio Launcher
echo   KEEP THIS WINDOW OPEN while account workers are running.
echo   Press Ctrl+C to stop the service and all account workers.
echo ============================================================
echo.
where node.exe >nul 2>nul
if errorlevel 1 goto node_error
node.exe --version
if not exist "src\server.mjs" goto source_error
if not exist "node_modules\playwright-core\package.json" goto dependency_error
echo [START] Starting the service. Runtime messages follow below.
echo [INFO] Closing the dashboard tab does NOT stop account workers.
echo.
node.exe "src\server.mjs" --console %*
set "LAUNCH_EXIT_CODE=%ERRORLEVEL%"
if not "%LAUNCH_EXIT_CODE%"=="0" goto runtime_error
echo.
echo [STOP] This launcher invocation has finished.
goto finish

:directory_error
echo [ERROR] Cannot open the project directory.
set "LAUNCH_EXIT_CODE=1"
goto finish_no_popd

:node_error
echo [ERROR] Node.js was not found. Install Node.js 22 or newer.
set "LAUNCH_EXIT_CODE=1"
goto finish

:source_error
echo [ERROR] Missing src\server.mjs. Restore the project source files.
set "LAUNCH_EXIT_CODE=1"
goto finish

:dependency_error
echo [ERROR] Missing playwright-core. Run npm ci in this directory.
set "LAUNCH_EXIT_CODE=1"
goto finish

:runtime_error
echo.
echo [ERROR] Service exited with code %LAUNCH_EXIT_CODE%. Read the output above.

:finish
popd
:finish_no_popd
echo.
echo Press any key to close this window...
pause >nul
exit /b %LAUNCH_EXIT_CODE%
