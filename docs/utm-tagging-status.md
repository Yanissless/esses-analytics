# UTM tagging: what works, what doesn't, what's left

**Last verified against live data: 14 Aug 2026.**

> **This is the internal/technical status doc.** The version to hand to the social manager is
> [`utm-guide-social-manager.md`](utm-guide-social-manager.md) (21 Aug), published as a Google Doc:
> **[Esses — Link Tagging Guide (21 Aug 2026 — current)](https://docs.google.com/document/d/1cF0hw4P2oUvZB6mF8Rs6eniKss9a5yRVwMlVICsij-c/edit)**
>
> Uploaded as `text/html`, not markdown. Markdown is what mangled the 4 Aug attempt — Drive
> converted its tables into empty-header rows with literal `**Where**` in the cells. HTML
> converts to real Doc headings, bold and lists.
>
> **Two stale Google Docs exist in Sam's Drive**, both dated 4 Aug and both titled some variant
> of "Esses — UTM Tagging Guide". Both open by claiming Esses cannot tell paid Instagram traffic
> from organic, which this document corrects. (An older note said the Drive connector was
> create-and-read only, so they could not be tidied up. That is no longer true — it now exposes
> update, share and trash as well, so the stale copies can be replaced properly once Sam says so.)
>
> Numbers below are 14 Aug. As of 21 Aug: paid-meta 350 touchpoints (100% carrying campaign and
> ad), organic Instagram 1,620 with only 30 tagged, newsletter 72 with none.

This supersedes the fragmented advice in earlier notes. It exists because the guidance drifted
across several conversations and ended up implying that nothing was working. That was wrong.

---

## Correction first: your tagging IS working

Measured in `attribution_touchpoints` today:

| Check | Result |
|---|---|
| paid-meta touchpoints carrying a campaign ID | **340** |
| ...of which carry an ad ID too | **340** |
| Campaign IDs that match a real campaign in `ad_spend` | **340 / 340 (100%)** |
| Ad IDs that match a real ad in `ad_spend` | **206 / 340 (61%)** |
| Most recent tagged paid-meta touchpoint | **today** |

The values are Meta's numeric IDs, exactly the right format:

```
campaign = 120248671551720507   (Free Quarterly Campaign)
content  = 120248945792520507   (a specific ad)
```

**So whatever you and the social manager have been doing on those ads is correct and is
landing.** Nothing needs redoing. Earlier notes suggested tagging Meta ads would produce
nothing — that applied only to the esses.com-destination ads described below, and was stated
far too broadly.

One clarification on mechanism, because it affects how you add more: Meta's API shows
`url_tags` set on only **1 of 200** ads. So the tagging is not in Ads Manager's "URL
parameters" field — it is appended directly to each ad's destination URL. That works equally
well. Either method is fine; just know which one you are using so you can find it later.

---

## The four tagging surfaces

### 1. Meta ads pointing at Shopify URLs — WORKING ✅

Example destination:
`essesmag.myshopify.com/cart/clear?return_to=/cart/add?items[]...`

The click lands on a **Shopify** page, so Shopify's own analytics record the UTM parameters and
we read them straight off the order's customer journey. This is why the numbers above exist.

**Action: none.** Keep tagging new ads the same way.

### 2. Meta ads pointing at esses.com — BROKEN ❌

Example destination: `esses.com/stories/pepe-marti` (33 ads, the Editorial campaign).

The click lands on **Craft**, which Shopify never sees. The UTM parameters arrive on esses.com
and are discarded at the handoff to checkout. Tagging these ads changes nothing on its own —
this is the case the earlier note was really about.

**Action:** esses.com must capture the parameters on landing and attach them to the cart. Full
brief with working code: `docs/esses-com-attribution.md`.

### 3. Organic social links — NOT TAGGED ❌

The largest single source of traffic, and currently anonymous:

```
organic-social | source=Instagram | 1,475 touchpoints | campaign: 0 | content: 0
organic-social | source=Facebook  |    80 touchpoints | campaign: 0 | content: 0
```

We can see the visit came from Instagram. We cannot tell **which post, story or bio link**
produced it, because no campaign or content value ever arrives.

**Action:** tag the links the social manager places by hand. Bio link, story link stickers,
link-in-bio tool destinations. There are no Meta macros here — the values are typed, so use a
consistent scheme:

```
?utm_source=instagram&utm_medium=organic_social&utm_campaign=<what it is>&utm_content=<which post>
```

Worked examples:

```
?utm_source=instagram&utm_medium=organic_social&utm_campaign=issue08_launch&utm_content=bio_link
?utm_source=instagram&utm_medium=organic_social&utm_campaign=issue08_launch&utm_content=story_2026_08_14
?utm_source=instagram&utm_medium=organic_social&utm_campaign=pepe_marti&utm_content=reel_grid_post
```

Rules that make the data usable rather than merely present:

- `utm_medium` must be **`organic_social`**, never `paid` — that word is what separates paid
  from organic in our classifier, and getting it wrong files organic traffic as advertising.
- Lowercase, underscores, no spaces. `Issue08` and `issue08` become two different campaigns.
- Keep `utm_campaign` stable across a push and vary `utm_content` per placement. That is what
  lets you compare a story against a grid post within the same campaign.

**Only tag links pointing at Shopify** for now. A tagged link to esses.com hits problem 2.

### 4. Newsletter — PARTIALLY TAGGED ⚠️

```
newsletter | medium=email | 59 touchpoints | campaign: 0 | last seen 2 Apr 2026
```

`utm_medium=email` is arriving, so we know it is the newsletter, but there is no campaign value
and nothing since April — either sends stopped or the links lost their tags.

**Action:** add `utm_campaign=<issue or send name>` to newsletter links, same scheme as above
with `utm_source=newsletter&utm_medium=email`.

---

## Where to see whether it worked

`/creatives` shows, per creative: **Meta's purchase count beside ours**, and labels the gap.
"untagged — Meta sees 11, we can't trace them" means that specific ad's clicks carried no tag
we could match.

One thing to know when reading that page: its "creatives tagged" counter is scoped to the
**selected date range**, and an ad only counts if it was tagged AND had spend in that window.
A low figure there does not mean tagging is broken account-wide — the 340 touchpoints above
are proof it is not.

## Priority

1. **Surface 3 (organic social)** — 1,555 anonymous touchpoints, by far the biggest blind spot,
   and it needs no developer.
2. **Surface 2 (esses.com)** — 33 ads plus all future editorial traffic, needs a developer.
3. **Surface 4 (newsletter)** — smallest volume, quickest fix.
