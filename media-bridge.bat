@echo off
rem Hermes Minimal media bridge - serves local media to the extension on http://127.0.0.1:8643
rem Keep this window open while you want the bridge running. Close it (or Ctrl+C) to stop.
cd /d "%~dp0"
python media-bridge.py
pause
