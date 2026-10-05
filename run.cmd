@echo off
REM Convenience launcher for Esses Analytics commands.
REM
REM Node and pnpm were installed after this machine's shells were started, so a
REM fresh terminal (or an app's Run button) may not have them on PATH yet. This
REM wrapper points at their real locations, so `run.cmd <script>` always works
REM without needing a reboot or a new terminal session.
REM
REM Usage:  run.cmd check:shopify
REM         run.cmd sync
REM         run.cmd start

setlocal
set "NODE_DIR=C:\Program Files\nodejs"
set "NPM_GLOBAL=%APPDATA%\npm"
set "PATH=%NODE_DIR%;%NPM_GLOBAL%;%PATH%"

cd /d "%~dp0"

if "%~1"=="" (
  echo Usage: run.cmd ^<pnpm-script^>  e.g.  run.cmd check:shopify
  echo.
  echo First time here?  run.cmd install   then   run.cmd check:deploy
  echo.
  echo   check:deploy     verify config, database, data and connectors
  echo   check:shopify    verify Shopify auth + scopes
  echo   check:ads        verify Meta credentials
  echo   check:meta       diagnose WHY Meta is failing ^(token vs app vs scope^)
  echo   check:analyst    verify the /ask analyst: every tool, and the role boundary
  echo   check:ga4        verify the Google Analytics connection
  echo   sync:instagram   pull Instagram follower counts via the Graph API
  echo   sync:creatives   cache ad creative previews from Meta
  echo   set:goals        set annual targets, split into monthly goals
  echo   db:migrate       create/update database tables
  echo   db:seed          create the first admin login
  echo   backfill         load history  --since=2025-10-01 --source=shopify
  echo   sync             incremental catch-up, all sources
  echo   metrics          rebuild order_profit + daily_metrics
  echo   validate         check live data against its invariants
  echo   review           flagged-order review queue
  echo   digest:preview   print the daily digest email without sending it
  echo   digest:send      actually email the daily digest ^(CPR/churn/subs/spend^)
  echo   test / lint / build / start / dev
  echo.
  echo Any pnpm command works too, e.g.  run.cmd install
  exit /b 1
)

REM The dev server builds into its own directory so a concurrent `run.cmd build` can't
REM pull the ground out from under a browser session someone is using. See next.config.ts.
if /I "%~1"=="dev" set "NEXT_DIST_DIR=.next-dev"

call "%NPM_GLOBAL%\pnpm.cmd" %*
endlocal
