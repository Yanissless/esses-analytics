@echo off
REM ===========================================================================
REM  Double-click this file to refresh all the data in Esses Analytics.
REM
REM  ## Why this uses node.exe directly and never pnpm
REM
REM  It failed three times on Sam's machine while passing every test on mine.
REM  The reason turned out to be sandbox virtualisation, not any bug in the
REM  batch file:
REM
REM    %APPDATA%\npm\pnpm.cmd  is a REPARSE POINT into
REM    AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\npm\
REM
REM  The Claude desktop app runs in an MSIX container where %APPDATA% is
REM  redirected. pnpm was installed from inside that container, so it only
REM  exists at the redirected location. Commands I run resolve to it; a plain
REM  Explorer double-click resolves to the real C:\Users\samwi\AppData\Roaming,
REM  where pnpm is genuinely absent. Same path string, two different files.
REM
REM  run.cmd has the same %APPDATA%\npm dependency, which means it has NEVER
REM  worked outside the container either.
REM
REM  So nothing here may touch AppData. Both things it uses are real files on
REM  disk, visible to every process:
REM
REM    C:\Program Files\nodejs\node.exe   - system-wide Node install
REM    node_modules\tsx\dist\cli.mjs      - a HARDLINK, so real content, and
REM                                         its junction points inside the
REM                                         project folder rather than AppData
REM
REM  ASCII only, CRLF endings, and no chcp - changing the codepage part way
REM  through a batch file can make cmd.exe lose its place in the script.
REM ===========================================================================

title Esses Analytics - updating data

echo.
echo  ===========================================
echo   ESSES ANALYTICS - UPDATING DATA
echo  ===========================================
echo.

set "HERE=%~dp0"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
set "TSX=%HERE%node_modules\tsx\dist\cli.mjs"

echo  Project folder : %HERE%
echo  Node           : %NODE_EXE%
echo  tsx            : %TSX%
echo.

if not exist "%HERE%package.json" (
  echo  PROBLEM: package.json not found in the folder above.
  echo  Keep this file inside the esses-analytics folder. A Desktop
  echo  SHORTCUT is fine, a COPY somewhere else is not.
  goto failed
)

if not exist "%NODE_EXE%" (
  echo  PROBLEM: Node.js is not installed at the path above.
  echo  Install it from nodejs.org, then try again.
  goto failed
)

if not exist "%TSX%" (
  echo  PROBLEM: the project dependencies are not installed.
  echo  Ask Claude to run the install step, then try again.
  goto failed
)

cd /d "%HERE%"
if errorlevel 1 (
  echo  PROBLEM: could not enter the project folder.
  goto failed
)

echo  All three found. Starting.
echo.
echo  This takes about 5-10 minutes. You can minimise this
echo  window, but do not close it.
echo.
echo  -------------------------------------------
echo   Step 1 of 2: pulling new data
echo  -------------------------------------------
echo.

"%NODE_EXE%" "%TSX%" "%HERE%scripts\sync.ts"
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

"%NODE_EXE%" "%TSX%" "%HERE%scripts\rebuild-metrics.ts"
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
