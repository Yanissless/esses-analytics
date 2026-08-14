@echo off
REM ===========================================================================
REM  Double-click this file to refresh all the data in Esses Analytics.
REM
REM  ## Why this does NOT call run.cmd
REM
REM  It used to, and it failed on Sam's machine with only "The system cannot
REM  find the path specified" and no pnpm output at all - meaning run.cmd died
REM  before reaching pnpm. It could never be reproduced from a terminal, so
REM  rather than keep guessing at a layer I cannot observe, this file now does
REM  the work itself: set PATH, then invoke pnpm directly.
REM
REM  Every path is printed and checked BEFORE it is used, so the next failure
REM  names the thing that is missing instead of producing one cryptic line.
REM
REM  There is deliberately no `chcp` call. Changing the console codepage part
REM  way through a batch file can make cmd.exe lose its position in the script,
REM  because it re-reads the file by byte offset. Mojibake in the output is
REM  cosmetic; a launcher that does not run is not.
REM
REM  ASCII only, CRLF endings. No em dashes, no smart quotes, ever.
REM ===========================================================================

title Esses Analytics - updating data

echo.
echo  ===========================================
echo   ESSES ANALYTICS - UPDATING DATA
echo  ===========================================
echo.

set "HERE=%~dp0"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
set "PNPM_CMD=%APPDATA%\npm\pnpm.cmd"

echo  Project folder : %HERE%
echo  Node           : %NODE_EXE%
echo  pnpm           : %PNPM_CMD%
echo.

if not exist "%HERE%package.json" (
  echo  PROBLEM: package.json not found in the folder above.
  echo  Keep this file inside the esses-analytics folder. A Desktop
  echo  SHORTCUT is fine, a COPY somewhere else is not.
  goto failed
)

if not exist "%NODE_EXE%" (
  echo  PROBLEM: Node.js is not installed at the path above.
  echo  Reinstall Node.js from nodejs.org, then try again.
  goto failed
)

if not exist "%PNPM_CMD%" (
  echo  PROBLEM: pnpm is not installed at the path above.
  echo  Open PowerShell and run:  npm install -g pnpm
  goto failed
)

set "PATH=C:\Program Files\nodejs;%APPDATA%\npm;%PATH%"

echo  All three found. Starting.
echo.
echo  This takes about 5-10 minutes. You can minimise this
echo  window, but do not close it.
echo.
echo  -------------------------------------------
echo   Step 1 of 2: pulling new data
echo  -------------------------------------------
echo.

cd /d "%HERE%"
if errorlevel 1 (
  echo  PROBLEM: could not enter the project folder.
  goto failed
)

call "%PNPM_CMD%" sync
if errorlevel 1 (
  echo.
  echo  The data pull reported a problem. Scroll up for the reason.
  goto failed
)

echo.
echo  -------------------------------------------
echo   Step 2 of 2: recomputing profit and metrics
echo  -------------------------------------------
echo.

call "%PNPM_CMD%" metrics
if errorlevel 1 (
  echo.
  echo  The metrics rebuild reported a problem. Scroll up for the reason.
  goto failed
)

echo.
echo  ===========================================
echo   DONE - everything is up to date.
echo  ===========================================
echo.
echo  Refresh the dashboard in your browser.
echo.
pause
exit /b 0

:failed
echo.
echo  ===========================================
echo   SOMETHING WENT WRONG
echo  ===========================================
echo.
echo  Send Claude this whole window, including the
echo  three paths listed near the top.
echo.
echo  Your existing data has NOT been damaged. A failed
echo  sync leaves what was already there untouched.
echo.
pause
exit /b 1
