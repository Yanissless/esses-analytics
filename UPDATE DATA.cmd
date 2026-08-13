@echo off
REM ============================================================================
REM  Double-click this file to refresh all the data in Esses Analytics.
REM
REM  It exists because `run.cmd sync` requires knowing how to open a terminal,
REM  navigate to this folder, and type a command with the right prefix. That is
REM  three chances to get it wrong before anything happens. This is one click.
REM
REM  It runs the two steps that must ALWAYS happen together:
REM    1. sync    — pull new orders, subscriptions, payments, ad spend, Instagram
REM    2. metrics — recompute profit and the daily rollup from what just arrived
REM
REM  Skipping step 2 leaves the dashboards showing yesterday's numbers over
REM  today's data, which is worse than not syncing at all because it looks fine.
REM
REM  The window stays open at the end so the result can actually be read.
REM ============================================================================

title Esses Analytics - updating data
cd /d "%~dp0"

echo.
echo  ===========================================
echo   ESSES ANALYTICS - UPDATING DATA
echo  ===========================================
echo.
echo  This takes about 5-10 minutes. You can minimise
echo  this window, but don't close it.
echo.
echo  Step 1 of 2: pulling new data from Shopify,
echo  Skio, Stripe, Meta and Instagram...
echo.

call "%~dp0run.cmd" sync
if errorlevel 1 goto failed

echo.
echo  Step 2 of 2: recomputing profit and metrics...
echo.

call "%~dp0run.cmd" metrics
if errorlevel 1 goto failed

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
echo.
echo  ===========================================
echo   SOMETHING WENT WRONG
echo  ===========================================
echo.
echo  Scroll up to find the line starting with "error"
echo  or a red message, and send that to Claude.
echo.
echo  Your existing data has NOT been damaged — a failed
echo  sync leaves what was already there untouched.
echo.
pause
exit /b 1
