"use client";

import { useActionState, useState, useTransition } from "react";
import {
  tagAcquisitionCampaign,
  untagAcquisitionCampaign,
  type AcquisitionActionState,
} from "./acquisition-actions";
import { Badge, formatUsd } from "../_components/ui";

const initial: AcquisitionActionState = {};

const input =
  "w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100";
const button =
  "rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-800 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900";
const ghostButton =
  "rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800";

export interface TaggedCampaign {
  campaignId: string;
  campaignName: string;
  note: string | null;
  taggedAt: string;
}

export interface SearchResult {
  campaignId: string;
  campaignName: string;
  recentSpendCents: number;
  lastActiveDate: string;
  tagged: boolean;
}

function Msg({ state }: { state: AcquisitionActionState }) {
  if (!state.error && !state.ok) return null;
  return (
    <p className={`mt-1 text-xs ${state.error ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
      {state.error ?? state.ok}
    </p>
  );
}

function UntagButton({ campaignId, campaignName }: { campaignId: string; campaignName: string }) {
  const [state, action, pending] = useActionState(untagAcquisitionCampaign, initial);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="campaignId" value={campaignId} />
      <input type="hidden" name="campaignName" value={campaignName} />
      <button type="submit" disabled={pending} className={ghostButton}>
        {pending ? "Removing…" : "Untag"}
      </button>
      <Msg state={state} />
    </form>
  );
}

function TagButton({ campaignId, campaignName }: { campaignId: string; campaignName: string }) {
  const [state, action, pending] = useActionState(tagAcquisitionCampaign, initial);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="campaignId" value={campaignId} />
      <input type="hidden" name="campaignName" value={campaignName} />
      <button type="submit" disabled={pending} className={button}>
        {pending ? "Tagging…" : "Tag"}
      </button>
      <Msg state={state} />
    </form>
  );
}

/**
 * Search-any-campaign box, so a retired offer (Free Quarterly) stays findable
 * for reference against past weeks even after it drops out of the "last 30
 * days" picker below — Sam asked for this explicitly rather than having
 * untagging make a campaign disappear.
 */
function CampaignSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [pending, startTransition] = useTransition();

  function runSearch(q: string) {
    setQuery(q);
    if (!q.trim()) {
      setResults(null);
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/acquisition-campaigns/search?q=${encodeURIComponent(q)}`);
      const data = (await res.json()) as SearchResult[];
      setResults(data);
    });
  }

  return (
    <div className="mt-4 border-t border-neutral-100 pt-4 dark:border-neutral-800">
      <label className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">
        Search every campaign ever run — including retired ones like Free Quarterly, kept here
        for reference against past weeks
      </label>
      <input
        value={query}
        onChange={(e) => runSearch(e.target.value)}
        placeholder="e.g. Free Quarterly, Editorial, $20 Annual…"
        className={input}
      />
      {pending ? <p className="mt-2 text-xs text-neutral-400">Searching…</p> : null}
      {results && results.length === 0 && !pending ? (
        <p className="mt-2 text-xs text-neutral-400">No campaign matches &ldquo;{query}&rdquo;.</p>
      ) : null}
      {results && results.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {results.map((r) => (
            <li
              key={r.campaignId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-100 px-3 py-2 text-sm dark:border-neutral-800"
            >
              <div className="min-w-0">
                <span className="font-medium">{r.campaignName}</span>{" "}
                {r.tagged ? <Badge tone="emerald">tagged</Badge> : null}
                <div className="text-xs text-neutral-500">
                  {formatUsd(r.recentSpendCents)} lifetime spend · last active {r.lastActiveDate}
                </div>
              </div>
              {r.tagged ? (
                <UntagButton campaignId={r.campaignId} campaignName={r.campaignName} />
              ) : (
                <TagButton campaignId={r.campaignId} campaignName={r.campaignName} />
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function AcquisitionSettings({
  tagged,
  candidates,
}: {
  tagged: TaggedCampaign[];
  candidates: SearchResult[];
}) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
        Acquisition campaigns
      </h2>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        Which live campaigns count toward the &ldquo;Flagship CAC&rdquo; card above. This is
        deliberately separate from the blended CAC above it, which sums every campaign including
        pure-awareness ones — tag only the offer(s) actually meant to be judged on cost-per-signup.
      </p>

      {tagged.length === 0 ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Nothing tagged — Flagship CAC will read &ldquo;—&rdquo; until at least one campaign is
          tagged below.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {tagged.map((t) => (
            <li
              key={t.campaignId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-neutral-50 px-3 py-2 text-sm dark:bg-neutral-800/60"
            >
              <div className="min-w-0">
                <span className="font-medium">{t.campaignName}</span>
                <div className="text-xs text-neutral-500">
                  {t.note ?? "no note"} · tagged {new Date(t.taggedAt).toLocaleDateString()}
                </div>
              </div>
              <UntagButton campaignId={t.campaignId} campaignName={t.campaignName} />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t border-neutral-100 pt-4 dark:border-neutral-800">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
          Active in the last 30 days
        </h3>
        {candidates.length === 0 ? (
          <p className="text-xs text-neutral-400">No campaigns with spend in the last 30 days.</p>
        ) : (
          <ul className="space-y-1.5">
            {candidates
              .filter((c) => !c.tagged)
              .map((c) => (
                <li
                  key={c.campaignId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-100 px-3 py-2 text-sm dark:border-neutral-800"
                >
                  <div className="min-w-0">
                    <span className="font-medium">{c.campaignName}</span>
                    <div className="text-xs text-neutral-500">
                      {formatUsd(c.recentSpendCents)} last 30 days · last active {c.lastActiveDate}
                    </div>
                  </div>
                  <TagButton campaignId={c.campaignId} campaignName={c.campaignName} />
                </li>
              ))}
          </ul>
        )}
      </div>

      <CampaignSearch />
    </div>
  );
}
