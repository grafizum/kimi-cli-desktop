@echo off
setlocal
cd /d "%~dp0"

rem The app takes a single-instance lock, so an already-running installed copy
rem would make this preview exit immediately. Close it first.
taskkill /F /IM "Kimi Code Desktop.exe" >nul 2>&1

echo Launching Kimi Code Desktop from source ^(no build required^).
echo   Ctrl+R          reload the window after editing renderer files
echo   Ctrl+Shift+I    open DevTools (Console / Elements for debugging)
echo.
call "%~dp0node_modules\.bin\electron.cmd" .
if errorlevel 1 echo. & echo Launch failed - run "npm install" once, then try again.
if errorlevel 1 pause
endlocal
