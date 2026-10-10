@echo off
rem Starts Drishti and opens it in the browser. Close this window (or press Ctrl+C) to stop it.
cd /d "%~dp0"
start "" http://127.0.0.1:8765
python -m uvicorn app.main:app --port 8765
pause
