import { requireUser } from "@/lib/auth/current-user";
import {
  getGeoConcentration,
  getPersonaProfiles,
  getSegmentOverlap,
  META_CUSTOM_AUDIENCE_MIN,
  META_LOOKALIKE_SOURCE_MIN,
} from "@/metrics/personas";
import { Badge, Card, Stat, formatNum, formatUsd } from "../_components/ui";
import { Nav } from "../_components/nav";

export const dynamic = "force-dynamic";

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const money = (v: number | null) => (v == null ? "—" : formatUsd(v));

export default async function PersonasPage() {
  const user = await requireUser();
  const [profiles, overlap, geo] = await Promise.all([
    getPersonaProfiles(),
    getSegmentOverlap(),
    getGeoConcentration(12),
  ]);

  const lookalikeReady = profiles.filter((p) => p.meetsLookalikeMin);
  const fullPrice = profiles.find((p) => p.segment === "full_price");
  const discount = profiles.find((p) => p.segment === "discount_dependent");
  const tryers = profiles.find((p) => p.segment === "single_issue_tryer");
  const topDecile = profiles.find((p) => p.segment === "high_value");
  const usGeo = geo.find((g) => g.country === "US");
  const gbGeo = geo.find((g) => g.country === "GB");

  return (
    <div className="min-h-full bg-neutral-50 dark:bg-neutral-950">
      <Nav email={user.email} role={user.role} />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Personas &amp; audiences</h1>
          <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
            Who actually buys and stays, defined by behaviour — the evidence for writing
            persona-specific creative and seeding Meta audiences.
          </p>
        </div>

        {/* Why behavioural, tied to their own targeting research. */}
        <div className="rounded-xl border border-blue-300 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
          <strong>These are behavioural segments, not demographic ones — on purpose.</strong> Your
          own targeting research concluded that Meta age/gender targeting costs 2–3× per placement
          and works as an exclusion filter rather than a targeting tool, and that hyper-specific
          creative is what actually performs because Advantage+ reads the copy and targets on signals
          Meta won&rsquo;t let you select. We hold no age, gender, income or interest data — Shopify
          doesn&rsquo;t collect it. What we hold is what people <em>did</em>, which is both the better
          input to creative and the only thing that can seed a Custom Audience → Lookalike.
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Best Lookalike seed"
            value={fullPrice ? formatNum(fullPrice.contactableCustomers) : "—"}
            hint={fullPrice ? `${fullPrice.label} · LTV ${money(fullPrice.ltvCents)}` : ""}
            emphasis
          />
          <Stat
            label="Full-price retention edge"
            value={
              fullPrice?.churnByFirstRenewalPct != null && discount?.churnByFirstRenewalPct != null
                ? `${(discount.churnByFirstRenewalPct / fullPrice.churnByFirstRenewalPct).toFixed(1)}×`
                : "—"
            }
            hint="discount-dependent churn ÷ full-price churn"
          />
          <Stat
            label="Untapped tryers"
            value={tryers ? formatNum(tryers.customers) : "—"}
            hint="bought once, never subscribed"
          />
          <Stat
            label="Lookalike-ready segments"
            value={formatNum(lookalikeReady.length)}
            hint={`${formatNum(META_LOOKALIKE_SOURCE_MIN)}+ contactable needed`}
          />
        </div>

        {/* The headline recommendation, stated once and plainly. */}
        {fullPrice && discount && topDecile ? (
          <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            <strong>Seed your Lookalike from full-price buyers, not from your best customers.</strong>{" "}
            The top-decile cohort is the ideal customer — LTV {money(topDecile.ltvCents)},{" "}
            {pct(topDecile.churnByFirstRenewalPct)} churn — but only{" "}
            {formatNum(topDecile.contactableCustomers)} are contactable, well under Meta&rsquo;s{" "}
            {formatNum(META_LOOKALIKE_SOURCE_MIN)} floor for a Lookalike source. Full-price buyers are{" "}
            {formatNum(fullPrice.contactableCustomers)} strong, carry LTV {money(fullPrice.ltvCents)},
            and churn {pct(fullPrice.churnByFirstRenewalPct)} against{" "}
            {pct(discount.churnByFirstRenewalPct)} for customers who only ever buy on a discount.
            That&rsquo;s the largest high-quality seed you have.
          </div>
        ) : null}

        {/* ---- the segment table ---- */}
        <Card
          title="Segments"
          subtitle="Sorted by lifetime value. Every definition is an observable action, so any row can be audited against orders."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Segment</th>
                  <th className="pb-2 text-right font-medium">Customers</th>
                  <th className="pb-2 text-right font-medium">LTV</th>
                  <th className="pb-2 text-right font-medium">AOV</th>
                  <th className="pb-2 text-right font-medium">Orders/cust</th>
                  <th className="pb-2 text-right font-medium">Subscribers</th>
                  <th className="pb-2 text-right font-medium">Churn by 1st renewal</th>
                  <th className="pb-2 font-medium">Meta audience</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {profiles.map((p) => {
                  const thinChurn = p.matureSubscriptions > 0 && p.matureSubscriptions < 30;
                  return (
                    <tr key={p.segment}>
                      <td className="py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{p.label}</span>
                          {p.customers < 25 ? <Badge tone="amber">tiny</Badge> : null}
                        </div>
                        <div className="mt-0.5 max-w-md text-xs text-neutral-500">
                          {p.definition}
                        </div>
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatNum(p.customers)}
                        <div className="text-xs text-neutral-500">{pct(p.shareOfPaying)}</div>
                      </td>
                      <td className="py-2 text-right font-medium tabular-nums">
                        {money(p.ltvCents)}
                      </td>
                      <td className="py-2 text-right tabular-nums">{money(p.aovCents)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {p.ordersPerCustomer?.toFixed(1) ?? "—"}
                      </td>
                      <td className="py-2 text-right tabular-nums">{pct(p.subscriberShare)}</td>
                      <td
                        className={`py-2 text-right tabular-nums ${
                          p.churnByFirstRenewalPct == null
                            ? "text-neutral-400"
                            : p.churnByFirstRenewalPct > 0.5
                              ? "text-red-600 dark:text-red-400"
                              : p.churnByFirstRenewalPct < 0.2
                                ? "text-emerald-600 dark:text-emerald-400"
                                : ""
                        }`}
                      >
                        {pct(p.churnByFirstRenewalPct)}
                        <div className="text-xs text-neutral-500">
                          {p.matureSubscriptions === 0
                            ? "no mature subs"
                            : `n=${p.matureSubscriptions}${thinChurn ? " thin" : ""}`}
                        </div>
                      </td>
                      <td className="py-2">
                        {p.meetsLookalikeMin ? (
                          <Badge tone="emerald">Lookalike + Custom</Badge>
                        ) : p.meetsCustomAudienceMin ? (
                          <Badge tone="blue">Custom only</Badge>
                        ) : (
                          <Badge tone="neutral">too small</Badge>
                        )}
                        <div className="mt-0.5 text-xs text-neutral-500">
                          {formatNum(p.contactableCustomers)} contactable
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
            <strong>Segments overlap on purpose</strong> — one customer can be a collector, a
            full-price buyer and international at once — so the customer column does not sum to the
            base. Churn is measured only over subscriptions old enough to have faced a first renewal,
            and <strong>annual plans mostly have none yet</strong>, which is why their sample is
            small. Anything marked <em>thin</em> (under 30) is a lead, not a conclusion. &ldquo;Meta
            audience&rdquo; reflects Meta&rsquo;s own minimums:{" "}
            {formatNum(META_CUSTOM_AUDIENCE_MIN)} matched for a Custom Audience,{" "}
            {formatNum(META_LOOKALIKE_SOURCE_MIN)} to seed a Lookalike.
          </p>
        </Card>

        {/* ---- geography, answering the doc's location question ---- */}
        <Card
          title="Where the value is"
          subtitle="Your targeting doc lists UK, Canada and US — this is what those markets are actually worth per customer"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                  <th className="pb-2 font-medium">Market</th>
                  <th className="pb-2 text-right font-medium">Customers</th>
                  <th className="pb-2 text-right font-medium">Share</th>
                  <th className="pb-2 text-right font-medium">LTV</th>
                  <th className="pb-2 text-right font-medium">AOV</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {geo.map((g) => (
                  <tr key={g.country ?? "unknown"}>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{g.country ?? "(unknown)"}</span>
                        {g.customers < 25 ? <Badge tone="amber">tiny sample</Badge> : null}
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatNum(g.customers)}</td>
                    <td className="py-2 text-right tabular-nums">{pct(g.share)}</td>
                    <td className="py-2 text-right font-medium tabular-nums">
                      {money(g.ltvCents)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{money(g.aovCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {usGeo && gbGeo ? (
            <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
              <strong>
                The UK buys bigger but is worth less: AOV {money(gbGeo.aovCents)} against the US&rsquo;s{" "}
                {money(usGeo.aovCents)}, yet LTV {money(gbGeo.ltvCents)} against{" "}
                {money(usGeo.ltvCents)}.
              </strong>{" "}
              UK customers place one large order and don&rsquo;t come back, which is a retention
              problem rather than an acquisition one — worth testing a UK-specific subscription offer
              before spending more on UK prospecting. Markets below ~25 customers are far too small to
              act on individually, however attractive their LTV looks.
            </p>
          ) : null}
        </Card>

        {/* ---- overlap ---- */}
        {overlap.length > 0 ? (
          <Card
            title="Segment overlap"
            subtitle="Check before running several campaigns at once — heavily overlapping audiences show the same people the same ads"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                    <th className="pb-2 font-medium">Segment A</th>
                    <th className="pb-2 font-medium">Segment B</th>
                    <th className="pb-2 text-right font-medium">Both</th>
                    <th className="pb-2 text-right font-medium">Of the smaller</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {overlap.slice(0, 14).map((o) => (
                    <tr key={`${o.a}-${o.b}`}>
                      <td className="py-2 font-mono text-xs">{o.a}</td>
                      <td className="py-2 font-mono text-xs">{o.b}</td>
                      <td className="py-2 text-right tabular-nums">
                        {formatNum(o.bothCustomers)}
                      </td>
                      <td
                        className={`py-2 text-right font-medium tabular-nums ${
                          (o.overlapOfSmaller ?? 0) > 0.8 ? "text-amber-600 dark:text-amber-400" : ""
                        }`}
                      >
                        {pct(o.overlapOfSmaller)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
              Pairs above 80% are effectively the same audience — target one of them, not both. Note
              most segments overlap heavily with <code className="font-mono">us_core</code> simply
              because ~88% of paying customers are American; that&rsquo;s scale, not a targeting
              insight.
            </p>
          </Card>
        ) : null}

        {/* ---- how to action, including the privacy point ---- */}
        <Card
          title="Turning these into Meta audiences"
          subtitle="What to do with the table above, and the one thing to check first"
        >
          <ol className="space-y-3 text-sm">
            <li>
              <strong>1. Write creative per segment, not per demographic.</strong> The definition
              column is the creative brief. &ldquo;You own three issues and the fourth just
              dropped&rdquo; speaks to collectors; &ldquo;you bought one issue and never came
              back&rdquo; speaks to the {tryers ? formatNum(tryers.customers) : ""} tryers. Per your
              research, that specificity is what Advantage+ actually reads.
            </li>
            <li>
              <strong>2. Seed one Lookalike from full-price buyers.</strong> It&rsquo;s the only
              high-quality segment over Meta&rsquo;s {formatNum(META_LOOKALIKE_SOURCE_MIN)} floor.
              Don&rsquo;t seed from top-decile — too small to qualify.
            </li>
            <li>
              <strong>3. Retarget the smaller segments as Custom Audiences</strong> rather than using
              them for prospecting: lapsed subscribers and single-issue tryers have already shown
              they&rsquo;ll pay, which makes them the cheapest wins available.
            </li>
            <li>
              <strong>4. Exclude discount-dependent customers from acquisition campaigns.</strong>{" "}
              They churn hardest and carry the lowest subscription value, so a Lookalike seeded from
              them would actively find more of the wrong people.
            </li>
          </ol>
          <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <strong>Before uploading any customer list to Meta:</strong> a Custom Audience means
            sending customer emails to a third party for advertising. That needs a lawful basis and a
            privacy policy that discloses it — for UK/EU customers especially, and Esses has{" "}
            {gbGeo ? formatNum(gbGeo.customers) : "some"} UK customers. This app deliberately does
            <strong> not</strong> export contact lists automatically; the counts above are sizing
            information only. Worth a quick check with whoever owns the privacy policy before the
            first upload.
          </div>
        </Card>
      </main>
    </div>
  );
}
