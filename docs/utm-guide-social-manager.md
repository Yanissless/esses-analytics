# Link tagging: what to do

**For:** the social & marketing manager · **From:** Sam · **Checked against live data 21 August 2026**

This replaces the Google Doc titled *"Esses — UTM Tagging Guide"* (4 August). **If you have
been working from that one, one thing in it is now wrong** — see the next section.

---

## Read this first: the paid ads are already fine

The August version of this guide opened by saying Esses could not tell paid Instagram traffic
from organic. That is no longer true, and it may not have been true when it was written.

Checked today:

- **350** visits from paid Meta ads arrived carrying a campaign tag.
- **All 350** also carried the specific ad.
- Every one matched a real campaign in the ad account.

**So whatever you are doing on the paid ads is working. Do not change it, and do not redo any
of it.** The tags are appended directly to each ad's destination URL rather than set in Ads
Manager's "URL parameters" field. Both methods work; it is only worth knowing which you use so
you can find it later.

There is one real gap, and it is on the organic side.

---

## Where things actually stand

**Paid Meta ads → the shop.** Working. Nothing to do.

**Organic Instagram, Facebook, Threads, TikTok.** This is the gap. 1,620 visits came from
Instagram links, and only **30 of them** — under 2% — carry any campaign tag. We can see the
visit came from Instagram. We cannot tell which post, story, or bio link produced it. This is
the largest single source of traffic to the shop and it is almost entirely anonymous.

*The 30 that are tagged are new since the last check, so this has already started. It just
needs to become the default rather than the exception.*

**The newsletter.** 72 visits, **none** carrying a campaign name, most recent 6 June. We know
it is the newsletter and nothing else about it.

**Ads pointing at esses.com** (rather than the shop). Tagging these changes nothing yet — the
tags are lost when the reader crosses from esses.com to the checkout. That needs a developer,
it is on Sam's list, and it is **not** your problem. Until it is fixed, only tag links that
point at the shop.

---

## The tag

Three things on the end of a link, plus one optional fourth:

```
?utm_source=instagram&utm_medium=organic_social&utm_campaign=issue08_launch&utm_content=bio_link
```

Read as: *came from Instagram · it was a free post, not an ad · part of the Issue 08 push · via
the bio link.*

That is the whole mechanic. The rest of this page is which words to use, because the system
matches on exact words and an unrecognised one files the visit as "unknown".

---

## Exactly which words

**Where it came from — `utm_source`**

Use the platform's plain name, lowercase: `instagram`, `facebook`, `tiktok`, `threads`,
`youtube`, `pinterest`, `linkedin`, `reddit`, `newsletter`.

**Free post or paid ad — `utm_medium`**

This is the one that matters most, because it is the word that decides whether our ad budget
gets credited for the traffic.

- Free post, story, reel, grid post: **`organic_social`**
- The link in your bio: **`bio`**
- Anything we paid for: **`paid_social`** (or `cpc` for Google ads)
- Newsletter or email: **`email`**

Also accepted for free posts, if one reads better: `organic`, `social`, `post`, `story`,
`reel`. Also accepted for paid: `cpc`, `ppc`, `paid`, `cpm`, `display`, `retargeting`.

**Not** accepted, and each of these silently becomes "unknown": `sponsored`, `ad`, `promo`,
`ig`, `insta`, `Paid Social` with a space.

**What it was for — `utm_campaign`**

Yours to choose. Lowercase, underscores instead of spaces. Keep it the *same* across everything
in one push, so the push can be measured as a whole:

`issue08_launch` · `issue07_restock` · `monaco_gp_2026` · `blackfriday_2026` ·
`subscription_push_q3`

**Which placement — `utm_content`** (optional, but this is where the useful answers live)

Vary this per placement while `utm_campaign` stays fixed. That is what lets you see whether a
story out-pulled a grid post *within the same campaign*:

`bio_link` · `story_2026_08_21` · `reel_grid_post` · `carousel_3`

---

## Three rules

**1. Never tag a link between two Esses pages.** Homepage to a product, product to checkout,
anything inside the site. The tags mean "this is where the reader came from", so tagging an
internal link claims a customer arrived at Esses from Esses. This has already bitten us once:
before it was fixed, our own website showed up as the biggest referral source in the business
at $34,000, purely from internal navigation. Only tag links that live somewhere else.

**2. Never put a paid word on a free post.** Tagging a free Instagram post `paid_social` credits
the ad budget with traffic we got for nothing. That makes advertising look better than it is,
and the risk is real money spent on the strength of a wrong number. Free post →
`organic_social`. Paid → `paid_social`. No exceptions.

**3. Lowercase, no spaces.** `issue08_launch`, not `Issue 08 Launch`. Spaces break links when
they get copied around, and `Summer` and `summer` are counted as two different campaigns.

---

## What to do, in order

**1. Tag the organic links from now on.** Bio link, story link stickers, whatever your
link-in-bio tool points at. This is the big one — roughly 1,600 visits currently anonymous — and
it needs nobody but you. Pattern:

```
?utm_source=instagram&utm_medium=organic_social&utm_campaign=<the push>&utm_content=<the placement>
```

**2. Add a campaign name to newsletter links.** Same idea, `utm_source=newsletter` and
`utm_medium=email`, plus `utm_campaign=<the send>`.

**3. Nothing on the paid ads.** They are working.

Nothing here is retrospective — tagging affects visits from the moment it goes live, so the
sooner it is routine, the sooner the numbers mean something. There is no need to go back and
fix old posts.

---

## How to check it worked

Ask Sam for the **Campaigns & creatives** page. It shows, per ad and campaign, Meta's own
purchase count beside the one we can actually trace, and says which ads carried no tag we could
match.

One quirk when reading it: the "creatives tagged" counter only counts ads that were tagged
**and** spent money inside the selected date range. A low number there does not mean tagging is
broken — the 350 tagged visits above are proof it is not.

Tagged links take a day or two to show up, because the visit only becomes visible to us once it
turns into an order.
