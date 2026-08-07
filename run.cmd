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
  echo   db:migrate       create/update database tables
  echo   db:seed          create the first admin login
  echo   backfill         load history  --since=2025-10-01 --source=shopify
  echo   sync             incremental catch-up, all sources
  echo   metrics          rebuild order_profit + daily_metrics
  echo   review           flagged-order review queue
  echo   test / lint / build / start / dev
  echo.
  echo Any pnpm command works too, e.g.  run.cmd install
  exit /b 1
)

call "%NPM_GLOBAL%\pnpm.cmd" %*
endlocal
