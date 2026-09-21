@echo off
rem Fake Kimi Code CLI used by scripts/e2e-test.js — never shipped to users.
if "%~1"=="--version" (
  echo kimi 9.9.9-test
  exit /b 0
)
if "%~1"=="login" (
  echo OPEN https://example.com/kimi/device
  echo ENTER CODE: ABCD-EFGH
  exit /b 0
)
rem `kimi web --port <p>` mimic: print the banner the app parses, then sleep
rem forever (the app stops the server by killing this process). No HTTP service
rem is needed for the e2e assertions — the app only reads the banner.
if "%~1"=="web" (
  call :web %*
  exit /b %errorlevel%
)

echo KIMI-TUI-STARTED args=[%*]
set /p kimi_line=INPUT:
echo YOU-TYPED:%kimi_line%
echo KIMI-REASONING-STREAMED-OK
exit /b 0

:web
set KCD_PORT=58627
:webargs
shift
if "%~0"=="" goto webrun
if "%~0"=="--port" set KCD_PORT=%~1
goto webargs
:webrun
echo   Fake Kimi server ready  9.9.9-test
echo.
echo   Local:    http://127.0.0.1:%KCD_PORT%/#token=FAKEWEBTOKEN0123456789abcdef
echo   Stop:     Ctrl+C
rem Stay alive so the app treats the server as running; killed on tab close.
ping -n 3600 127.0.0.1
exit /b 0
