@echo off
rem Hermes Extension media bridge - serves local media to the extension on http://127.0.0.1:8643
rem Keep this window open while you want the bridge running. Close it (or Ctrl+C) to stop.
cd /d "%~dp0"
rem -B: never write __pycache__ (Chrome/Edge refuse _-prefixed names at the extension root)
python -B media-bridge.py
pause
