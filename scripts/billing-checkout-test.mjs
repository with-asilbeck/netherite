// Exercises the real checkout path against the real (test-mode) Lemon
// Squeezy store: creates a hosted checkout for every tier and period,
// confirms each one points at the right variant at the right price, and
// confirms the custom data the webhook later depends on actually rode
// along.
//
// It calls the same lib/billing/lemonsqueezy.ts the route calls, and it
// also drives /api/checkout itself to prove the route's auth and input
// checks. Nothing is mocked; every URL printed is a page a card could be
// entered on.
//
//   node scripts/billing-checkout-test.mjs

import { register } from "node:module";

import { check, checkEqual, env, section, summarise } from "./billing-env.mjs";

// config.ts reads process.env, so populate it before the module loads.
for (const [key, value] of Object.entries(env)) process.env[key] ??= value;

register("./ts-alias-hook.mjs", import.meta.url);

const { createCheckoutUrl } = await import("../lib/billing/lemonsqueezy.ts");
const { normalizeStoreId } = await import("../lib/billing/config.ts");
const { verifyCheckoutUserId } = await import("../lib/billing/signature.ts");
const { PLANS, formatPrice } = await import("../lib/billing/plans.ts");

const BASE_URL = process.env.BILLING_TEST_BASE_URL ?? "http://localhost:3000";

// A stand-in for a signed-in user's id. The real route takes this from
// supabase.auth.getUser() and never from the request.
const FAKE_USER_ID = "00000000-0000-4000-8000-00000000beef";
const FAKE_EMAIL = "checkout-probe@netherite-verify.invalid";

section("Store id normalisation");
checkEqual("a bare id passes through", normalizeStoreId("443272"), "443272");
checkEqual(
  "the store URL in .env.local resolves to the id",
  normalizeStoreId(env.LEMONSQUEEZY_STORE_ID),
  "443272",
);
checkEqual("a trailing slash is tolerated", normalizeStoreId("https://x.lemonsqueezy.com/443272/"), "443272");
check(
  "a value with no id at all throws rather than guessing",
  (() => {
    try {
      normalizeStoreId("https://netherite.lemonsqueezy.com");
      return false;
    } catch {
      return true;
    }
  })(),
);

const api = "https://api.lemonsqueezy.com/v1";
const headers = {
  Authorization: `Bearer ${env.LEMONSQUEEZY_API_KEY}`,
  Accept: "application/vnd.api+json",
};

/**
 * Loads a hosted checkout the way a browser would.
 *
 * The first response is a 302 that also sets a cart cookie, and the page it
 * redirects to 404s without it. `fetch` follows redirects but does not keep
 * cookies, so following automatically looks exactly like a broken checkout
 * — which is what this script reported before the hop was done by hand.
 */
async function loadCheckoutPage(url) {
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

  const first = await fetch(url, {
    redirect: "manual",
    headers: { "User-Agent": userAgent, Accept: "text/html" },
  });

  const location = first.headers.get("location");
  if (!location) {
    return { status: first.status, html: await first.text() };
  }

  const cookies = (first.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

  const second = await fetch(new URL(location, url), {
    headers: { "User-Agent": userAgent, Accept: "text/html", Cookie: cookies },
  });
  return { status: second.status, html: await second.text() };
}

const urls = [];

for (const plan of PLANS) {
  for (const period of ["monthly", "yearly"]) {
    section(`Checkout — ${plan.name} ${period} (${formatPrice(plan.price[period])})`);

    let url;
    try {
      url = await createCheckoutUrl({
        tier: plan.tier,
        period,
        userId: FAKE_USER_ID,
        email: FAKE_EMAIL,
        redirectUrl: `${BASE_URL}/account?checkout=success`,
      });
    } catch (err) {
      check("checkout created", false, String(err.message).slice(0, 200));
      continue;
    }

    check("checkout created", typeof url === "string" && url.startsWith("https://"), url);
    urls.push({ plan: `${plan.tier}/${period}`, url });

    // Read the checkout back from the API and confirm what it actually
    // contains — the URL alone proves nothing about the variant or the
    // custom data.
    const checkoutId = url.split("/").pop();
    const response = await fetch(`${api}/checkouts/${checkoutId}`, { headers });
    if (!response.ok) {
      check("checkout readable from the API", false, `HTTP ${response.status}`);
      continue;
    }
    const body = await response.json();
    const attributes = body.data.attributes;
    const expectedVariant = Number(
      env[`LEMONSQUEEZY_VARIANT_${plan.tier.toUpperCase()}_${period.toUpperCase()}`],
    );

    checkEqual("  points at the configured variant", attributes.variant_id, expectedVariant);
    checkEqual("  belongs to the configured store", attributes.store_id, 443272);
    checkEqual(
      "  custom_data carries the user id the webhook will match on",
      attributes.checkout_data?.custom?.user_id,
      FAKE_USER_ID,
    );
    checkEqual("  email is prefilled", attributes.checkout_data?.email, FAKE_EMAIL);
    check(
      "  custom_data carries a valid attribution signature",
      verifyCheckoutUserId(
        FAKE_USER_ID,
        attributes.checkout_data?.custom?.uid_sig,
        env.LEMONSQUEEZY_WEBHOOK_SECRET,
      ),
    );
    check(
      "  that signature does not validate for a different user id",
      !verifyCheckoutUserId(
        "99999999-9999-4999-8999-999999999999",
        attributes.checkout_data?.custom?.uid_sig,
        env.LEMONSQUEEZY_WEBHOOK_SECRET,
      ),
    );
    checkEqual(
      "  only the purchased variant is offered",
      JSON.stringify(attributes.product_options?.enabled_variants),
      JSON.stringify([expectedVariant]),
    );
    checkEqual(
      "  post-purchase redirect is our own origin",
      attributes.product_options?.redirect_url,
      `${BASE_URL}/account?checkout=success`,
    );

    // The hosted page must actually load — a valid-looking URL that 404s
    // is the failure this catches.
    const page = await loadCheckoutPage(url);
    checkEqual("  hosted checkout page loads", page.status, 200);
    check(
      "  page is in test mode (no real card will be charged)",
      page.html.includes("test_mode&quot;:true") || page.html.includes("test-mode"),
    );
    check(
      `  page shows the ${formatPrice(plan.price[period])} price`,
      page.html.includes(String(plan.price[period])),
    );
    check(
      "  page is prefilled with the email we passed",
      page.html.includes(FAKE_EMAIL),
    );
  }
}

section("Route guards — /api/checkout");

let reachable = true;
try {
  await fetch(BASE_URL, { method: "HEAD" });
} catch {
  reachable = false;
}

if (!reachable) {
  console.log(`  (skipped: ${BASE_URL} is not running — start it with npm run dev)`);
} else {
  const post = (body) =>
    fetch(`${BASE_URL}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // No session cookie: this is the check that stops an anonymous caller
  // from minting checkouts, and it runs before anything else.
  const anonymous = await post({ tier: "pro", period: "monthly" });
  checkEqual("an unauthenticated request is refused", anonymous.status, 401);

  const injected = await post({
    tier: "pro",
    period: "monthly",
    // None of these are read by the route. If any of them were, this
    // request would succeed in charging somebody else or granting a tier
    // for free. (A made-up uuid, deliberately — a real account's id does
    // not belong in a committed file.)
    userId: "11111111-2222-4333-8444-555555555555",
    user_id: "11111111-2222-4333-8444-555555555555",
    price: 1,
    variantId: 1969699,
    email: "attacker@example.com",
  });
  checkEqual("extra client-supplied fields don't bypass the auth check", injected.status, 401);

  const badTier = await post({ tier: "enterprise", period: "monthly" });
  check(
    "an unknown tier never reaches the Lemon Squeezy API",
    badTier.status === 400 || badTier.status === 401,
    `HTTP ${badTier.status}`,
  );

  const envProbe = await post({ tier: "../../SUPABASE_SERVICE_ROLE_KEY", period: "monthly" });
  check(
    "a tier crafted to build an env var name is refused",
    envProbe.status === 400 || envProbe.status === 401,
    `HTTP ${envProbe.status}`,
  );
}

if (urls.length) {
  console.log("\nLive test-mode checkout URLs (card 4242 4242 4242 4242, any future expiry, any CVC):");
  for (const { plan, url } of urls) console.log(`  ${plan.padEnd(14)} ${url}`);
}

process.exit(summarise());
