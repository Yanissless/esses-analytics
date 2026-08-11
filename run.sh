#!/usr/bin/env bash
#
# macOS / Linux twin of run.cmd.
#
# Every command in DEPLOY.md, CLAUDE.md and START-HERE.md is written as
# `.\run.cmd <script>` because the whole app was built on Windows. This file exists so
# those commands translate one-for-one on a Mac: read `.\run.cmd x` as `./run.sh x`.
#
# It also resolves pnpm the way run.cmd does. pnpm ships with Node via corepack but is
# often not on PATH in a fresh shell, which produces a bare "command not found" that
# reads like a broken project rather than a missing shim.
#
# Usage:  ./run.sh install
#         ./run.sh check:deploy
#
set -euo pipefail

cd "$(dirname "$0")"

if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  # corepack downloads the pnpm version pinned in package.json on first use.
  PNPM=(corepack pnpm)
else
  cat >&2 <<'EOF'
pnpm not found, and corepack isn't available either.

Install Node 20+ (which bundles corepack), then enable pnpm:

  brew install node
  corepack enable pnpm

Then re-run this command.
EOF
  exit 1
fi

if [ $# -eq 0 ]; then
  cat <<'EOF'
Usage: ./run.sh <pnpm-script>   e.g.  ./run.sh check:deploy

First time here?  ./run.sh install   then   ./run.sh check:deploy

  check:deploy     verify config, database, data and connectors
  check:shopify    verify Shopify auth + scopes
  check:ads        verify Meta credentials
  check:meta       diagnose WHY Meta is failing (token vs app vs scope)
  db:migrate       create/update database tables
  db:seed          create the first admin login
  backfill         load history  --since=2025-10-01 --source=shopify
  sync             incremental catch-up, all sources
  metrics          rebuild order_profit + daily_metrics
  review           flagged-order review queue
  test / lint / build / start / dev

Any pnpm command works too, e.g.  ./run.sh install
EOF
  exit 1
fi

exec "${PNPM[@]}" "$@"
