@echo off
REM ===========================================================================
REM  Double-click this to build this week's handoff package for Hugh:
REM    1. A zip of the source code as it sits on disk right now -- no secrets,
REM       no node_modules, no build output.
REM    2. A dump of the current database, so his copy shows real, current data
REM       without him ever needing any Shopify/Skio/Stripe/Meta credentials.
REM
REM  Run this weekly (or whenever you want to send Hugh an update). Nothing
REM  else needs to change on his end each week -- see HUGH-SETUP.md.
REM
REM  ## Why this copies the working folder instead of using git
REM
REM  `git archive` only exports the last COMMIT. Sam commits in batches, not
REM  after every change, so most weeks that would silently ship Hugh a stale
REM  build missing whatever's still unsaved -- exactly the kind of thing that
REM  eats a Friday call figuring out why his copy doesn't match. Copying the
REM  actual folder means Hugh always gets exactly what's running here.
REM
REM  ## Why the DB password is never typed into this file
REM
REM  It's read out of .env at the moment this runs, the same file the app
REM  itself reads it from. Nothing here hardcodes it, so this script is safe
REM  to keep in git even though the export it produces (which contains a real
REM  customer database) is not -- see the .gitignore entry for handoff-exports/.
REM
REM  Same constraints as START-APP.cmd: only node.exe/robocopy/powershell/
REM  pg_dump.exe and files inside the project are used, nothing touches
REM  %APPDATA%. robocopy and powershell ship with every Windows install, so
REM  nothing extra needs installing to run this.
REM
REM  ASCII only, CRLF endings.
REM ===========================================================================

title Esses Analytics - export for Hugh

echo.
echo  ===========================================
echo   BUILDING THIS WEEK'S PACKAGE FOR HUGH
echo  ===========================================
echo.

set "HERE=%~dp0"
set "PG_DUMP=C:\Program Files\PostgreSQL\17\bin\pg_dump.exe"
cd /d "%HERE%"
if errorlevel 1 (
  echo  PROBLEM: could not enter %HERE%
  goto failed
)

if not exist "%PG_DUMP%" (
  echo  PROBLEM: pg_dump.exe not found at:
  echo    %PG_DUMP%
  echo  Ask Claude to check where Postgres 17 is installed.
  goto failed
)

if not exist ".env" (
  echo  PROBLEM: .env not found. This needs the real DATABASE_URL to dump the
  echo  live database -- ask Claude to check.
  goto failed
)

REM --- pull DATABASE_URL out of .env without ever printing or hardcoding it ---
set "DATABASE_URL="
for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
  if "%%A"=="DATABASE_URL" set "DATABASE_URL=%%B"
)
if "%DATABASE_URL%"=="" (
  echo  PROBLEM: DATABASE_URL is not set in .env.
  goto failed
)

set "STAMP=%date:~-4%-%date:~4,2%-%date:~7,2%"
set "OUTDIR=%HERE%handoff-exports\%STAMP%"
set "SRCDIR=%OUTDIR%\esses-analytics-source"
if not exist "%OUTDIR%" mkdir "%OUTDIR%"
if exist "%SRCDIR%" rmdir /s /q "%SRCDIR%"

echo  [1/3] Copying the source folder (this can take a minute)...
robocopy "%HERE%." "%SRCDIR%" /E /XD node_modules .git .next .next-dev handoff-exports /XF .env .env.local >nul
REM robocopy's exit codes are not a plain 0=ok/1=fail -- 0-7 all mean success,
REM only 8+ means something actually went wrong.
if errorlevel 8 (
  echo  PROBLEM: copying the source folder failed. Run this from a normal
  echo  terminal to see robocopy's own error, or ask Claude.
  goto failed
)

REM Belt and braces: /XF above only catches the .env filenames it's told about by
REM name, so if a NEW .env variant ever gets created on disk (.env.local,
REM .env.production, whatever) this sweep still catches it before it reaches
REM Hugh. .env.example is the one variant that's meant to ship.
for %%F in ("%SRCDIR%\.env*") do (
  if /I not "%%~nxF"==".env.example" del /q "%%F"
)

echo  [2/3] Zipping it up...
powershell -NoProfile -Command "Compress-Archive -Path '%SRCDIR%\*' -DestinationPath '%OUTDIR%\esses-analytics-source.zip' -Force"
if errorlevel 1 (
  echo  PROBLEM: zipping failed. See the error above.
  goto failed
)
rmdir /s /q "%SRCDIR%"

echo  [3/3] Dumping the database (this can take a minute)...
"%PG_DUMP%" --format=custom --no-owner --no-privileges --file="%OUTDIR%\esses-analytics-data.dump" --dbname="%DATABASE_URL%"
if errorlevel 1 (
  echo  PROBLEM: pg_dump failed. See the error above.
  goto failed
)

echo.
echo  ===========================================
echo   DONE
echo  ===========================================
echo.
echo  Ready to send to Hugh:
echo    %OUTDIR%\esses-analytics-source.zip
echo    %OUTDIR%\esses-analytics-data.dump
echo.
echo  That dump is a real copy of the customer database (names, emails, order
echo  history) -- send it somewhere reasonably private (a shared drive link,
echo  not a public channel), same as you'd treat any customer data export.
echo.
echo  First time sending someone a package? They need TEAM-SETUP.md (already
echo  inside the source zip) for one-time setup instructions -- Mac and
echo  Windows both covered, Mac first since that's what most people are on.
echo.
pause
exit /b 0

:failed
echo.
echo  ===========================================
echo   EXPORT FAILED
echo  ===========================================
echo.
echo  Send Claude this whole window.
echo.
pause
exit /b 1
