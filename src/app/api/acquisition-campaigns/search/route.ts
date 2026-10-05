/**
 * Search every campaign ever run, for the acquisition-campaign tagging picker
 * on /marketing. A client component (not a server action) because it's typed
 * as the user goes, same reason any search box is a GET rather than a form
 * submission — see `metrics/flagship-cac.ts`'s `searchCampaigns` for why this
 * has to cover all-time and not just the last 30 days.
 *
 * Behind `requireCapability("marketing")`, same as the page it serves —
 * `proxy.ts` guards pages, API routes check explicitly.
 */
import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/current-user";
import { searchCampaigns } from "@/metrics/flagship-cac";

export async function GET(req: Request) {
  await requireCapability("marketing");
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const results = await searchCampaigns(q);
  return NextResponse.json(results);
}
