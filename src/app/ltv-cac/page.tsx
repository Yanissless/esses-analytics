import { requireCapability } from "@/lib/auth/current-user";
import { blendLtv, getLtvCacTable, type TierRow } from "@/metrics/ltv-cac";
import { Badge, Card, InfoTip, Stat, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";
import { LtvCacForms } from "./forms";

export const dynamic = "force-dynamic";

const pct = (v: number | null, digits = 1) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);
const ratioText = (v: number | null) => (v == null ? "—" : `${v.toFixed(2)}x`);
const monthsText = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)} months`);

const NEEDS_CONFIRMATION = "NEEDS CONFIRMATION";

export default async function LtvCacPage() {
  const user = await requireCapability("margin");
  const rows = await getLtvCacTable();
  const blended = blendLtv(rows);
  const flagged = rows.filter((r) => r.note?.includes(NEEDS_CONFIRMATION));
  const today = new Date().toISOString().slice(0, 10);

  // Quarterly, not Annual, because its r1/r2 are measured from live renewals rather than
  // assumed — the more honest row to lead the walkthrough with. Falls back to the first row
  // if that tier ever gets renamed, so the breakdown card never renders empty.
  const worked = rows.find((r) => r.tier === "quarterly") ?? rows[0];

  const best = rows.reduce<TierRow | null>(
    (m, r) => (r.ltvCac != null && (m === null || r.ltvCac > (m.ltvCac ?? -Infinity)) ? r : m),
    null,
  );
  const worst = rows.reduce<TierRow | null>(
    (m, r) => (r.ltvCac != null && (m === null || r.ltvCac < (m.ltvCac ?? Infinity)) ? r : m),
    null,
  );

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">LTV &amp; CAC</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Survival-weighted, discounted, contribution-based LTV against CAC — for the two
            subscription products that actually exist, per Ojus Jain&rsquo;s methodology (10 Aug
            2026).
          </p>
        </div>

        {flagged.length > 0 ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <strong>
              {flagged.map((r) => r.tierLabel).join(", ")} need{flagged.length === 1 ? "s" : ""}{" "}
              confirmation before you trust {flagged.length === 1 ? "its" : "their"} LTV.
            </strong>{" "}
            {flagged.map((r) => (
              <span key={`${r.tier}-${r.route}`} className="block">
                {r.note}
              </span>
            ))}
          </div>
        ) : null}

        {/* ---- headline: the decision table ---- */}
        <Card
          title="LTV : CAC by tier"
          subtitle="The number that answers 'is this subscriber worth acquiring' — always contribution basis, always a stated horizon"
          info={
            <>
              <strong>LTV</strong> = Σ [ C(t) × S(t) ] ÷ (1+d)^(t−1), t = 1 to T — survival-weighted,
              discounted, contribution-based. See &ldquo;How LTV is calculated&rdquo; below for the
              worked breakdown. <strong>CAC</strong> here is the same blended, marketing-only figure{" "}
              <code>/marketing</code> reports — ad spend ÷ new customers, all-time. It is{" "}
              <em>not</em> fully-loaded: growth salary, creative, agency, martech and affiliate
              payouts aren&rsquo;t tracked anywhere in the app yet. The CAC field below is
              editable, so once those figures exist they can be added in directly.
            </>
          }
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat
              label="Best LTV:CAC"
              value={best ? ratioText(best.ltvCac) : "—"}
              hint={best ? best.tierLabel : ""}
              emphasis
            />
            <Stat
              label="Worst LTV:CAC"
              value={worst ? ratioText(worst.ltvCac) : "—"}
              hint={worst ? worst.tierLabel : ""}
            />
            <Stat
              label="Rows below 3:1 target"
              value={formatNum(rows.filter((r) => r.ltvCac != null && r.ltvCac < r.targetRatio).length)}
              hint={`of ${formatNum(rows.length)} — FTI/INMA's practitioner bar (Section 8)`}
            />
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 pr-4 font-medium">Tier</th>
                  <th className="pb-2 pr-4 text-right font-medium">
                    <span className="inline-flex items-center gap-1">
                      LTV ({rows[0]?.inputs.horizonYears ?? 3}yr)
                      <InfoTip label="How this is calculated" align="right">
                        Discounted sum of expected contribution over the horizon — see &ldquo;How
                        LTV is calculated&rdquo; below for the exact year-by-year math for this
                        row. Contribution-based: never revenue, never infinite.
                      </InfoTip>
                    </span>
                  </th>
                  <th className="pb-2 pr-4 text-right font-medium">
                    <span className="inline-flex items-center gap-1">
                      CAC
                      <InfoTip label="How this is calculated" align="right">
                        Fully-loaded cost to acquire (or upgrade) one subscriber on this tier via
                        this route — media plus growth salary, creative, agency, martech and
                        affiliate payouts, as one editable figure. Edit it below; it is not
                        derived from ad spend automatically.
                      </InfoTip>
                    </span>
                  </th>
                  <th className="pb-2 pr-4 text-right font-medium">
                    <span className="inline-flex items-center gap-1">
                      LTV : CAC
                      <InfoTip label="How this is calculated" align="right">
                        LTV ÷ CAC. Below 2:1 is usually buying growth the business can&rsquo;t
                        fund; above 5:1 is usually underinvesting in growth; 3:1 is the FTI
                        Consulting / INMA practitioner convention this page tests against.
                      </InfoTip>
                    </span>
                  </th>
                  <th className="pb-2 pr-4 text-right font-medium">
                    <span className="inline-flex items-center gap-1">
                      Allowable CAC
                      <InfoTip label="How this is calculated" align="right">
                        LTV ÷ target ratio (default 3) — what CAC would need to be for this tier to
                        hit its target, shown beside the actual CAC so the gap is visible directly.
                      </InfoTip>
                    </span>
                  </th>
                  <th className="pb-2 text-right font-medium">
                    <span className="inline-flex items-center gap-1">
                      Payback
                      <InfoTip label="How this is calculated" align="right">
                        CAC ÷ year-1 contribution × 12, in months. Year-1 only — not the full LTV —
                        because payback asks when the FIRST charge cycle recovers the cost, before
                        any renewal is assumed. Under 12 months is generally healthy for a
                        consumer subscription; under 6 is excellent.
                      </InfoTip>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {rows.map((r) => {
                  const belowTarget = r.ltvCac != null && r.ltvCac < r.targetRatio;
                  const needsConfirm = r.note?.includes(NEEDS_CONFIRMATION);
                  return (
                    <tr key={`${r.tier}-${r.route}`}>
                      <td className="py-2 pr-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{r.tierLabel}</span>
                          {needsConfirm ? <Badge tone="amber">needs confirmation</Badge> : null}
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-right font-medium tabular-nums">
                        {formatUsd(r.ltv.ltvCents)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{formatUsd(r.cacCents)}</td>
                      <td
                        className={`py-2 pr-4 text-right font-medium tabular-nums ${
                          r.ltvCac == null
                            ? "text-neutral-400"
                            : belowTarget
                              ? "text-red-600 dark:text-red-400"
                              : "text-emerald-600 dark:text-emerald-400"
                        }`}
                      >
                        {ratioText(r.ltvCac)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-neutral-500">
                        {r.allowableCacCents == null ? "—" : formatUsd(r.allowableCacCents)}
                      </td>
                      <td className="py-2 text-right tabular-nums">{monthsText(r.paybackMonths)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
            Both tiers currently share the same blended CAC, so the LTV:CAC gap between them is
            driven entirely by price and retention. Annual&rsquo;s r1/r2 are still a placeholder
            (marked &ldquo;needs confirmation&rdquo; above) — its ratio will move once real
            annual renewals exist to measure from, the same way Quarterly&rsquo;s already do.
          </p>
        </Card>

        {/* ---- worked example, so any figure above can be audited by hand ---- */}
        {worked ? (
          <Card
            title={`How LTV is calculated — ${worked.tierLabel}`}
            subtitle="Every number in this row, in the open — the same walkthrough as the methodology doc's Section 5"
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="First-period contribution"
                value={formatUsd(worked.ltv.years[0]?.contributionCents ?? 0)}
                hint={`list ${formatUsd(worked.inputs.listPriceCents)} − ${pct(worked.inputs.introDiscountPct)} intro discount − ${pct(worked.inputs.processingPct)} processing − ${formatUsd(worked.inputs.annualCogsCents)} COGS, per ${worked.inputs.cycleMonths ?? 12}-month cycle`}
              />
              <Stat
                label="Renewal contribution"
                value={formatUsd(worked.ltv.years[1]?.contributionCents ?? worked.ltv.years[0]?.contributionCents ?? 0)}
                hint="full list price — no intro discount on renewals"
              />
              <Stat
                label={`${worked.inputs.horizonYears}-year LTV`}
                value={formatUsd(worked.ltv.ltvCents)}
                hint={`d=${pct(worked.inputs.discountRatePct)}, r1=${pct(worked.inputs.r1)}, r2=${pct(worked.inputs.r2)}`}
                emphasis
              />
              <Stat
                label="Naive perpetuity, for comparison"
                value={formatUsd(
                  Math.round(
                    (worked.ltv.years[1]?.contributionCents ?? 0) / (1 - worked.inputs.r1) || 0,
                  ),
                )}
                hint="contribution ÷ churn — what a simpler (wrong) formula would say"
              />
            </div>

            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                    <th className="pb-2 pr-4 font-medium">
                      {worked.ltv.cycleMonths === 12 ? "Year" : `Cycle (${worked.ltv.cycleMonths}mo)`}
                    </th>
                    <th className="pb-2 pr-4 text-right font-medium">Contribution C(t)</th>
                    <th className="pb-2 pr-4 text-right font-medium">Survival S(t)</th>
                    <th className="pb-2 pr-4 text-right font-medium">Discount factor</th>
                    <th className="pb-2 text-right font-medium">Discounted value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {worked.ltv.years.map((y) => (
                    <tr key={y.year}>
                      <td className="py-2 pr-4">
                        {worked.ltv.cycleMonths === 12 ? "Year" : "Cycle"} {y.year}
                        {y.year === 1 ? (
                          <span className="ml-1 text-xs text-neutral-500">(not discounted)</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {formatUsd(y.contributionCents)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {(y.survivalPct * 100).toFixed(1)}%
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        ÷{y.discountFactor.toFixed(4)}
                      </td>
                      <td className="py-2 text-right font-medium tabular-nums">
                        {formatUsd(y.discountedCents)}
                      </td>
                    </tr>
                  ))}
                  <tr className="font-medium">
                    <td className="py-2 pr-4" colSpan={4}>
                      {worked.inputs.horizonYears}-year LTV
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(worked.ltv.ltvCents)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
              <strong>Survival</strong> S(1)=1 (just signed up), S(2)=r1, and every cycle after
              multiplies by r2 again — churn is front-loaded, so more subscribers leave at the
              first renewal than at any later one. <strong>Discount factor</strong> converts
              cycles into real elapsed years before applying the annual discount rate — cycle 1 is
              received now and isn&rsquo;t discounted regardless of how long a cycle is; a
              {` ${worked.inputs.cycleMonths ?? 12}`}-month cycle discounts cycle 5 as{" "}
              {(((worked.inputs.cycleMonths ?? 12) * 4) / 12).toFixed(2)} years out, not 4. The
              annual-tier version of this row is checked to the cent in{" "}
              <code>tests/ltv-cac.test.ts</code> against the methodology doc&rsquo;s own worked
              example — a coding error here can&rsquo;t silently drift from the number the team
              has agreed to.
            </p>
          </Card>
        ) : null}

        {/* ---- portfolio LTV, with the doc's own caution attached ---- */}
        <Card
          title="Portfolio LTV — summary only"
          subtitle="What the subscriber book is worth today, weighted by base mix"
        >
          <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
            Both current tiers are acquired the same way, so unlike a book that includes an
            upgrade-only tier, this blend can reasonably be read against the blended CAC above.
            That stops being true the moment a tier is added that arrives by upgrade rather than
            acquisition (e.g. a future premium tier) — at that point this card goes back to
            &ldquo;summary only, don&rsquo;t compare it to CAC&rdquo;, per the methodology doc
            Section 10.
          </div>
          {blended.blendedLtvCents != null ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Stat
                label="Blended LTV"
                value={formatUsd(blended.blendedLtvCents)}
                hint={`weighted by base share across ${formatNum(blended.includedTiers.length)} tier(s)`}
              />
              <Stat
                label="Base share covered"
                value={pct(blended.totalShareCovered, 0)}
                hint={
                  blended.excludedTiers.length > 0
                    ? `excludes ${blended.excludedTiers.join(", ")} — no base share entered`
                    : "every tier has a share entered"
                }
              />
            </div>
          ) : (
            <p className="mt-4 text-sm text-neutral-500">
              No tier has a base share entered yet — add one in the forms below to compute this.
            </p>
          )}
        </Card>

        {/* ---- the editable assumptions ---- */}
        <div>
          <h2 className="mb-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
            Assumptions
          </h2>
          <p className="mb-4 text-xs text-neutral-500 dark:text-neutral-400">
            Everything above is computed live from these. Price and COGS are entered directly.
            Quarterly&rsquo;s r1/r2 were seeded from real measured renewals (
            <code>pnpm seed:ltv-cac</code>) rather than typed in — editing them here overrides
            that until the next reseed. Annual&rsquo;s r1/r2 are still an assumption, because no
            annual subscription has reached a renewal yet to measure from.
          </p>
          <LtvCacForms rows={rows} today={today} />
        </div>
      </main>
    </div>
  );
}
