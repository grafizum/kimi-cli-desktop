@echo off
rem Fake Kimi Code CLI used by scripts/e2e-test.js — never shipped to users.
if "%1"=="--version" (
  echo kimi 9.9.9-test
  exit /b 0
)
if "%1"=="login" (
  echo OPEN https://example.com/kimi/device
  echo ENTER CODE: ABCD-EFGH
  exit /b 0
)
echo KIMI-TUI-STARTED args=[%*]
set /p kimi_line=INPUT:
echo YOU-TYPED:%kimi_line%
echo KIMI-REASONING-STREAMED-OK
exit /b 0