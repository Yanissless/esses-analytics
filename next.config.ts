import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

/**
 * `dev` and `build`/`start` never share a `distDir`, so a build can't pull the ground out
 * from under a running dev server. Both commands default to `.next`; running `next build`
 * while `next dev` served from the same directory left the browser unable to fetch RSC
 * payloads, and because a `<Link>` click calls `preventDefault` before fetching, every click
 * was silently swallowed rather than falling back to a normal page load. It presented as
 * "the nav doesn't work" — a long way from the cause. It cost a debugging detour on
 * 12 Aug 2026, and again on 4 Sep 2026 when `next dev`/`next build` were run directly
 * (bypassing `run.cmd`, which previously was the only place setting this).
 *
 * This is keyed off Next's own `phase` argument, not an env var someone has to remember to
 * set — so it applies even to a bare `next dev` or `npx next build`, not just invocations
 * through `run.cmd`/pnpm scripts. `NEXT_DIST_DIR` still works as a manual override if ever
 * needed. Deployments are unaffected: Vercel passes no override and gets the default `.next`.
 *
 * Do not run `next build`/`next dev` directly against the same `distDir` from two terminals
 * at once — always let this file's phase detection (or an explicit `NEXT_DIST_DIR`) keep
 * them apart.
 */
export default function nextConfig(phase: string): NextConfig {
  const distDir =
    process.env.NEXT_DIST_DIR ||
    (phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next");

  return { distDir };
}
