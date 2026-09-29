@echo off
rem Claude Status watcher launcher (ASCII only - Big5 codepage parses this file)
rem Restart loop with backoff: 30s between restarts; after 5 consecutive failures
rem notify Discord and back off 10 minutes. Exit codes from watcher.js:
rem   2 = config error (stop loop), 3 = another instance running (retry in 5 min)
rem A run that lasted >= 600s counts as healthy: the consecutive-failure counter is reset
rem before its exit is counted, so only rapid crash loops reach the alert (2026-09-29).
set PATH=C:\Program Files\nodejs;%PATH%
cd /d "C:\Users\user\Desktop\dev\claude status"
set /a fails=0
:loop
call :now t0
"C:\Program Files\nodejs\node.exe" watcher.js >> watcher.log 2>&1
set rc=%errorlevel%
call :now t1
set /a ran=t1-t0
if %ran% LSS 0 set /a ran+=86400
if "%rc%"=="2" (
  echo [%date% %time%] watcher exited with config error, loop stopped >> watcher.log
  goto end
)
if "%rc%"=="3" (
  echo [%date% %time%] another instance is running, retry in 5 min >> watcher.log
  ping -n 301 127.0.0.1 >nul
  goto loop
)
if %ran% GEQ 600 set /a fails=0
set /a fails+=1
echo [%date% %time%] watcher exited rc=%rc% after %ran%s, consecutive fails=%fails% >> watcher.log
if %fails% GEQ 5 (
  "C:\Program Files\nodejs\node.exe" scripts\notify-fail.js "restarted %fails% times in a row, backing off 10 min (last rc=%rc%)" >> watcher.log 2>&1
  set /a fails=0
  ping -n 601 127.0.0.1 >nul
) else (
  ping -n 31 127.0.0.1 >nul
)
goto loop

:now
rem Seconds since midnight into the variable named by %1. %time% is HH:mm:ss.ff with a
rem leading space for hours below 10; the 1xx-100 trick avoids octal parsing of 08/09.
set t=%time: =0%
for /f "tokens=1-3 delims=:." %%a in ("%t%") do set /a %1=(1%%a-100)*3600+(1%%b-100)*60+(1%%c-100)
exit /b 0

:end
