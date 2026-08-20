@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "ENVFILE=%USERPROFILE%\.hermes\.env"

if not exist "%ENVFILE%" (
  echo Could not find %ENVFILE%
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
echo API key copied to clipboard.
echo Paste it into Hermes Extension settings, then click Test connection.
pause
