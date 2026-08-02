@echo off
rem Claude Status watcher launcher (ASCII only - see lessons re: Big5 codepage)
rem Auto-restarts node if the watcher crashes; 30s delay between restarts.
set PATH=C:\Program Files\nodejs;%PATH%
cd /d "C:\Users\user\Desktop\dev\claude status"
:loop
"C:\Program Files\nodejs\node.exe" watcher.js >> watcher.log 2>&1
ping -n 31 127.0.0.1 >nul
goto loop
