#!/bin/bash
# ===========================================================================
#  Double-click this file to START the Esses Analytics app, then open
#  http://localhost:3000 in your browser.
#
#  Mac equivalent of START-APP.cmd (the Windows version) -- same job, same
#  reason it exists: a server started from inside your own Terminal window
#  keeps running under your control, rather than depending on anything else
#  staying open.
#
#  NEXT_DIST_DIR=.next-dev keeps this server's build output separate from a
#  production build, so the two can't step on each other. See next.config.ts.
#
#  ## If double-clicking does nothing, or macOS warns it's from an
#  ## "unidentified developer"
#
#  Right-click (or Control-click) this file instead and choose Open, which
#  macOS allows even for an unsigned script. If it still won't run, open
#  Terminal, drag this file into the window, and press Return -- that runs it
#  directly and shows any real error.
#
#  If it says "Permission denied", the executable bit didn't survive
#  unzipping. Open Terminal in this folder and run:
#      chmod +x START-APP.command
#  then double-click it again.
# ===========================================================================

cd "$(dirname "$0")" || {
  echo "PROBLEM: could not find this folder. Try running this from Terminal instead."
  read -r -p "Press Return to close..."
  exit 1
}

echo
echo " ==========================================="
echo "  ESSES ANALYTICS - STARTING THE APP"
echo " ==========================================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo " PROBLEM: Node.js is not installed."
  echo " Install it (see TEAM-SETUP.md), then try again."
  read -r -p "Press Return to close..."
  exit 1
fi

if [ ! -f "node_modules/next/dist/bin/next" ]; then
  echo " PROBLEM: the project dependencies are not installed yet."
  echo " Open Terminal in this folder and run: pnpm install"
  echo " Then try again."
  read -r -p "Press Return to close..."
  exit 1
fi

export NEXT_DIST_DIR=.next-dev

echo " Starting the server. This takes about 15 seconds."
echo
echo " Then open this in your browser:"
echo
echo "     http://localhost:3000"
echo
echo " LEAVE THIS WINDOW OPEN while you use the app."
echo " Closing it stops the server."
echo
echo " -------------------------------------------"
echo

node node_modules/next/dist/bin/next dev

echo
echo " The server has stopped."
echo
read -r -p "Press Return to close..."
