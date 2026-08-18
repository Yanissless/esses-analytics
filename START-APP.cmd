@echo off
REM ===========================================================================
REM  Double-click this file to START the Esses Analytics app, then open
REM  http://localhost:3000 in your browser.
REM
REM  ## Why this exists
REM
REM  The dev server had only ever been started from inside Claude's own tool
REM  session, which meant it died whenever that session ended - three separate
REM  times Sam opened the app to ERR_CONNECTION_REFUSED through no fault of his
REM  own. A server Sam starts himself, in his own window, cannot be taken down
REM  by anything Claude does.
REM
REM  Same constraints as UPDATE DATA.cmd, for the same reason: nothing here may
REM  touch %APPDATA%, because pnpm lives inside the Claude app's MSIX container
REM  and is invisible to a plain Explorer double-click. Only node.exe and files
REM  inside the project are used.
REM
REM  NEXT_DIST_DIR=.next-dev keeps this server's build output separate from
REM  `run.cmd build`, so a production build running at the same time cannot pull
REM  the ground out from under a browser session. See next.config.ts.
REM
REM  ## Why the name has a hyphen and no space
REM
REM  It was "START APP.cmd" for about ten minutes. START is a cmd.exe BUILT-IN
REM  command, so 'cmd /c START APP.cmd' runs the START command with APP.cmd as its
REM  argument and reports "The system cannot find the file APP.cmd". An Explorer
REM  double-click happens to work, but anything invoking it through cmd does not.
REM
REM  (UPDATE DATA.cmd keeps its space: UPDATE is not a built-in, it already works,
REM  and Sam may have made a Desktop shortcut to it.)
REM
REM  ASCII only, CRLF endings.
REM ===========================================================================

title Esses Analytics - app server (keep this window open)

echo.
echo  ===========================================
echo   ESSES ANALYTICS - STARTING THE APP
echo  ===========================================
echo.

set "HERE=%~dp0"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
set "NEXT_BIN=%HERE%node_modules\next\dist\bin\next"
set "NEXT_DIST_DIR=.next-dev"

if not exist "%NODE_EXE%" (
  echo  PROBLEM: Node.js is not installed at:
  echo    %NODE_EXE%
  echo  Install it from nodejs.org, then try again.
  goto failed
)

if not exist "%NEXT_BIN%" (
  echo  PROBLEM: the project dependencies are not installed at:
  echo    %NEXT_BIN%
  echo  Ask Claude to run the install step, then try again.
  goto failed
)

cd /d "%HERE%"
if errorlevel 1 (
  echo  PROBLEM: could not enter %HERE%
  goto failed
)

echo  Starting the server. This takes about 15 seconds.
echo.
echo  Then open this in your browser:
echo.
echo      http://localhost:3000
echo.
echo  LEAVE THIS WINDOW OPEN while you use the app.
echo  Closing it stops the server.
echo.
echo  -------------------------------------------
echo.

"%NODE_EXE%" "%NEXT_BIN%" dev

echo.
echo  The server has stopped.
echo.
pause
exit /b 0

:failed
echo.
echo  ===========================================
echo   COULD NOT START
echo  ===========================================
echo.
echo  Send Claude this whole window.
echo.
pause
exit /b 1
