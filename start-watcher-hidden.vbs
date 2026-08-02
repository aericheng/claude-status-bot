' Runs start-watcher.cmd in a hidden window (see lessons 2026-07-12: visible cmd windows get closed by accident)
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Users\user\Desktop\dev\claude status\start-watcher.cmd""", 0, True
