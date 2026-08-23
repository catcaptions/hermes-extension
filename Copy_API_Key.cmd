@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem Try %LOCALAPPDATA%\hermes\.env first (actual HERMES_HOME on Windows), then %USERPROFILE%\.hermes\.env (legacy / WSL)
set "ENVFILE=%LOCALAPPDATA%\hermes\.env"
if not exist "%ENVFILE%" set "ENVFILE=%USERPROFILE%\.hermes\.env"
if not exist "%ENVFILE%" set "ENVFILE=%APPDATA%\hermes\.env"

if not exist "%ENVFILE%" (
  echo Could not find Hermes .env file.
  echo Checked:
  echo   %LOCALAPPDATA%\hermes\.env
  echo   %USERPROFILE%\.hermes\.env
  echo   %APPDATA%\hermes\.env
  echo Hermes Extension needs API_SERVER_KEY from your Hermes .env file.
  pause
  exit /b 1
)

set "KEY="
for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b "API_SERVER_KEY=" "%ENVFILE%"`) do set "KEY=%%B"

if not defined KEY (
  echo API_SERVER_KEY was not found in %ENVFILE%
  echo Enable the Hermes API server first, then try again.
  pause
  exit /b 1
)

<nul set /p "=!KEY!" | clip
echo API key copied from %ENVFILE% to clipboard.
echo Paste it into Hermes Extension settings, then click Test connection - Save.
echo If Create session still fails with 403 after Health OK, update API_SERVER_CORS_ORIGINS
echo in %ENVFILE% to include this extension's ID (chrome://extensions) then run: hermes gateway restart
pause
