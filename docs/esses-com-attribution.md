# Capturing ad attribution on esses.com

**Who this is for:** whoever maintains esses.com (Craft CMS).

**What it does:** lets Esses Analytics tell you which Instagram/Facebook ad produced
each subscription — which it currently cannot.

**Effort:** one script tag, plus one change wherever the checkout link is built.

---

## There are TWO ad paths, and they need different handling

| Ads | Where the click lands | Covered by Step 1+2 below? |
|---|---|---|
| Most campaigns | **esses.com** (Craft), then Shopify checkout | Yes |
| **Free quarterly** | **Skio free checkout, directly** | **No — see "The Skio path" below** |

Free quarterly is currently the **largest spender**, so the second row matters more than
the first. It bypasses esses.com entirely because Craft cannot yet issue $0 subscriptions,
so the ads point straight at Skio's hosted checkout. That is expected to change when
subscriptions move fully onto Craft; until then this path needs its own answer.

## Why this is needed

Ads point at **esses.com** (Craft). Checkout happens in **Shopify/Skio**.

Shopify's analytics only see the pages Shopify serves — i.e. the checkout. It never sees
the ad click landing on esses.com. Measured across the 30 most recent orders:

| Check | Result |
|---|---|
| Orders carrying any custom attribute | 0 / 30 |
| Orders with a UTM recorded anywhere | 0 / 30 |
| `landingPageUrl` on the order | always the checkout URL |
| Journey moments recorded per order | 1 (the checkout) |

So even with UTM parameters added to every Meta ad, **nothing would capture them**. They
would arrive on esses.com and be discarded at the handoff to checkout.

The fix is to carry them across that handoff. Once they arrive as order attributes, the
attribution rides on the order itself — which is more robust than relying on Shopify's
analytics, because it cannot be broken by a storefront Shopify doesn't control.

---

## Step 1 — capture on landing

Add this to the `<head>` of every page on esses.com (a Craft layout template is fine).
It has no dependencies and does not touch anything else on the page.

```html
<script>
(function () {
  var STORE_KEY = 'esses_attribution';
  var DAYS = 90;

  // First touch wins. Someone who clicks an ad, leaves, then returns via Google should
  // still be credited to the ad — overwriting on the later visit would credit Google
  // for a sale the ad paid for. Delete the cookie to start a new attribution window.
  try {
    if (localStorage.getItem(STORE_KEY)) return;
  } catch (e) { return; }

  var params = new URLSearchParams(window.location.search);
  var FIELDS = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid','gclid','ttclid'];

  var found = {};
  var any = false;
  FIELDS.forEach(function (f) {
    var v = params.get(f);
    if (v) { found[f] = v; any = true; }
  });

  // Referrer is recorded even with no parameters: it is the only signal for an untagged
  // click, and "instagram.com with no UTM" is still more than nothing.
  if (document.referrer && document.referrer.indexOf(location.hostname) === -1) {
    found.referrer = document.referrer;
    any = true;
  }
  if (!any) return;

  found.landing_page = window.location.href.slice(0, 500);
  found.captured_at = new Date().toISOString();

  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(found));
    // Cookie as well, so a server-side Craft template can read it too.
    document.cookie = STORE_KEY + '=' + encodeURIComponent(JSON.stringify(found)) +
      ';path=/;max-age=' + (DAYS * 86400) + ';SameSite=Lax';
  } catch (e) { /* private browsing — nothing to do */ }
})();
</script>
```

---

## Step 2 — attach it to the checkout

Find where esses.com sends someone to Shopify or Skio. It will be one of:

- a link to `essesmag.myshopify.com/cart/...`
- a "subscribe" button that builds a checkout URL
- a Skio embed / subscription widget

Shopify accepts **cart attributes** as URL parameters. Append them to that link:

```
?attributes[utm_source]=facebook&attributes[utm_content]=120249330189320507
```

Here is a helper that takes the existing checkout URL and returns it with the captured
values appended. Call it right before redirecting.

```html
<script>
function essesAppendAttribution(checkoutUrl) {
  var raw;
  try { raw = localStorage.getItem('esses_attribution'); } catch (e) { return checkoutUrl; }
  if (!raw) return checkoutUrl;

  var data;
  try { data = JSON.parse(raw); } catch (e) { return checkoutUrl; }

  var url = new URL(checkoutUrl, window.location.origin);
  Object.keys(data).forEach(function (k) {
    // Shopify caps attribute values; truncate rather than have it reject the whole cart.
    url.searchParams.set('attributes[' + k + ']', String(data[k]).slice(0, 255));
  });
  return url.toString();
}
</script>
```

Usage — wherever the checkout link is produced:

```html
<a href="https://essesmag.myshopify.com/cart/12345:1"
   onclick="this.href = essesAppendAttribution(this.href)">Subscribe</a>
```

If the checkout is built server-side in Craft, read the `esses_attribution` cookie in
Twig and append the same `attributes[...]` parameters there instead.

**If Skio creates the subscription rather than a Shopify cart link:** Skio passes cart
attributes through to the underlying Shopify order, so the same approach works — attach
them to the cart before Skio takes over. If Skio's widget doesn't expose that, tell us and
we'll read them from Skio's own metadata instead.

---

## Step 3 — how to know it worked

Place a test order through esses.com with a tagged link, e.g.:

```
https://esses.com/?utm_source=facebook&utm_medium=paid_social&utm_campaign=TEST123&utm_content=TESTAD456
```

Then in Shopify admin, open that order and scroll to **Additional details**. You should
see `utm_source`, `utm_campaign`, `utm_content` and the rest listed there.

If they appear, it is working, and Esses Analytics will pick them up on the next sync.

---

## The Skio path (free quarterly ads)

These ads point straight at Skio's hosted checkout, so the script above never runs — there
is no esses.com page in the journey to run it on.

The useful fact is that **a Skio subscription creates a Shopify order**. Skio's API exposes
`Orders { platformId }` per subscription, and Esses Analytics already reads `customAttributes`
off every Shopify order. So if Skio forwards checkout parameters onto the order it creates,
this path works with no extra code at all.

Whether it does is a property of Skio's implementation, and it is quicker to test than to
research.

### Test it first — 10 minutes, no code

1. Take the Skio checkout URL the free quarterly ads currently use.
2. Append test parameters:

   ```
   ?utm_source=facebook&utm_medium=paid_social&utm_campaign=SKIOTEST&utm_content=SKIOAD1
   ```

3. Complete a free subscription through it.
4. In Shopify admin, open the resulting order and look at **Additional details**.

**If the parameters appear:** nothing more to build. Tag the free quarterly ads with the
same string as every other campaign and they will be attributed.

**If they do not appear:** Skio drops them, and the fix is a redirect page (below).

### If Skio drops them: a thin redirect page

Point the free quarterly ads at an esses.com URL instead of the Skio one — e.g.
`https://esses.com/free-quarterly`. That page runs the Step 1 script like every other page,
then forwards immediately to the Skio checkout with the captured values appended.

This is worth doing even if it costs a redirect, because it puts capture under our control
on both paths rather than depending on a third party's parameter handling. It also survives
the eventual move off Skio: when subscriptions come onto Craft, only the redirect target
changes.

Keep the redirect server-side (a Craft route) rather than a JavaScript bounce, so the click
is not lost if scripts are slow or blocked.

## What NOT to do

- **Don't overwrite on every page view.** First touch wins; see the comment in Step 1.
- **Don't put personal data in attributes.** They end up on the order and are visible to
  anyone with Shopify admin access. UTM values and click IDs only.
- **Don't strip the query string on landing.** Some Craft redirect rules drop parameters on
  the way to the canonical URL. If UTMs vanish before the script runs, nothing downstream
  can recover them — this is the single most likely reason for this not to work.
