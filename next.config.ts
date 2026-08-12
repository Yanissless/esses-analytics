import type { NextConfig } from "next";

/**
 * `distDir` is overridable so a `build` cannot break a running `dev`.
 *
 * Both commands default to `.next`. Running `next build` while `next dev` is serving from
 * the same directory pulls the ground out from under the live server: the browser then
 * fails to fetch RSC payloads, and because a `<Link>` click calls `preventDefault` before
 * fetching, every click is silently swallowed rather than falling back to a normal page
 * load. It presents as "the nav doesn't work", which is a long way from the cause — it cost
 * a real debugging detour on 12 Aug 2026.
 *
 * So the dev server runs in its own directory (`run.cmd dev` sets `NEXT_DIST_DIR=.next-dev`)
 * and verification builds keep `.next` to themselves. Deployments are unaffected: Vercel
 * sets no override and gets the default.
 */
const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
