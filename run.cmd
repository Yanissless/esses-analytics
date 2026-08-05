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
  echo Available: check:shopify, sync, backfill, start, dev, review,
  echo            import:shipping, seed:costs, db:migrate, test
  exit /b 1
)

call "%NPM_GLOBAL%\pnpm.cmd" %*
endlocal
