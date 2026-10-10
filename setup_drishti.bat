@echo off
rem One-time setup on a new computer: installs what Drishti needs.
echo Installing Drishti requirements...
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo Something failed. Is Python installed? Get it from https://www.python.org/downloads/ and tick "Add Python to PATH".
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo.
  echo Created .env - open it with Notepad and put your keys after each = sign (same line, no spaces).
)
echo.
echo Done. Now double-click start_drishti.bat
pause
