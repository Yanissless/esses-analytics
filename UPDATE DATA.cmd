@echo off
REM ===========================================================================
REM  Double-click this file to refresh all the data in Esses Analytics.
REM
REM  Runs the two steps that must ALWAYS happen together:
REM    1. sync    - pull new orders, subscriptions, payments, ad spend, Instagram
REM    2. metrics - recompute profit and the daily rollup from what just arrived
REM
REM  Skipping step 2 leaves the dashboards showing yesterday's numbers over
REM  today's data, which is worse than not syncing at all because it looks fine.
REM
REM  ## This file MUST be saved as ASCII with CRLF line endings
REM
REM  The first version was written with LF endings and em dashes in these
REM  comments. cmd.exe requires CRLF, so with LF it mis-parsed the file and
REM  began EXECUTING fragments of the comment text - which surfaced to Sam as a
REM  bare "The system cannot find the path specified" with no clue as to which
REM  path. The em dashes also rendered as "GCo" mojibake in the console, which
REM  was the visible tell. Neither reproduced from a terminal, because the
REM  shells I was testing through normalised both.
REM
REM  So: no characters outside plain ASCII in this file, ever, and CRLF endings.
REM
REM  pushd rather than cd /d: it copes with a UNC or mapped-drive working
REM  directory, which Explorer can hand a batch file and cd /d cannot enter.
REM ===========================================================================

REM UTF-8 console: script output contains em dashes and accented country names,
REM which render as mojibake (GCo) in the default codepage. Sam is told to read
REM this window, so what it prints has to be legible.
chcp 65001 >nul
title Esses Analytics - updating data
echo.
echo  ===========================================
echo   ESSES ANALYTICS - UPDATING DATA
echo  ===========================================
echo.

set "HERE=%~dp0"
echo  Folder: %HERE%

pushd "%HERE%" 2>nul
if errorlevel 1 (
  echo.
  echo  PROBLEM: could not enter that folder.
  echo  If the path above starts with two backslashes it is a network
  echo  location, which needs mapping to a drive letter first.
  goto failed
)

if not exist "%HERE%run.cmd" (
  echo.
  echo  PROBLEM: run.cmd is not in that folder.
  echo  Keep this file in the esses-analytics folder next to run.cmd.
  echo  A Desktop SHORTCUT is fine. A COPY is not.
  goto failed
)

if not exist "%HERE%package.json" (
  echo.
  echo  PROBLEM: package.json is missing, so this is not the project folder.
  goto failed
)

echo  Found run.cmd and package.json. Starting.
echo.
echo  This takes about 5-10 minutes. You can minimise this
echo  window, but do not close it.
echo.
echo  -------------------------------------------
echo   Step 1 of 2: pulling new data
echo  -------------------------------------------
echo.

call "%HERE%run.cmd" sync
if errorlevel 1 goto failed

echo.
echo  -------------------------------------------
echo   Step 2 of 2: recomputing profit and metrics
echo  -------------------------------------------
echo.

call "%HERE%run.cmd" metrics
if errorlevel 1 goto failed

popd
echo.
echo  ===========================================
echo   DONE - everything is up to date.
echo  ===========================================
echo.
echo  Refresh the dashboard in your browser to see
echo  the new numbers.
echo.
pause
exit /b 0

:failed
popd 2>nul
echo.
echo  ===========================================
echo   SOMETHING WENT WRONG
echo  ===========================================
echo.
echo  Send Claude everything in this window, including
echo  the "Folder:" line near the top.
echo.
echo  Your existing data has NOT been damaged. A failed
echo  sync leaves what was already there untouched.
echo.
pause
exit /b 1
