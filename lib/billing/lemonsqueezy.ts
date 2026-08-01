import {
  createCheckout,
  getSubscription,
  lemonSqueezySetup,
  listLicenseKeys,
} from "@lemonsqueezy/lemonsqueezy.js";

import { apiKey, storeId, variantIdFor, webhookSecret } from "./config";
import type { BillingPeriod, PaidTier } from "./plans";
import { signCheckoutUserId } from "./signature";

// Thin wrapper over the Lemon Squeezy SDK. Every call the app makes to
// Lemon Squeezy goes through here so there is one place that knows about
// the API key, one place that turns their error shape into ours, and no
// route that talks to the API directly.

let configured = false;

/**
 * `lemonSqueezySetup` mutates module-level state in the SDK, so it needs to
 * run once before the first call and must not run on import — reading the
 * key at import time would make a missing env var a boot failure for the
 * whole app rather than a failure of the billing routes.
 */
function ensureSetup(): void {
  if (configured) return;
  lemonSqueezySetup({
    apiKey: apiKey(),
    onError: (error) => {
      // Logged, not swallowed: callers still get the error via the
      // returned `error` field and decide the HTTP response.
      console.error("[billing] Lemon Squeezy API error:", error);
    },
  });
  configured = true;
}

export type CheckoutRequest = {
  tier: PaidTier;
  period: BillingPeriod;
  userId: string;
  email: string;
  /** Where Lemon Squeezy sends the customer after a successful purchase. */
  redirectUrl: string;
};

/**
 * Creates a hosted checkout and returns its URL.
 *
 * The `custom` payload is the whole reason this is a server-side API call
 * rather than a link to the product's public buy URL: it rides along with
 * every webhook Lemon Squeezy later sends for the resulting subscription,
 * and it is what lets `subscription_created` find the right user. It is
 * trustworthy on the way back only because the webhook route verifies the
 * signature before reading it.
 *
 * `userId` must come from `supabase.auth.getUser()` on the server. Taking
 * it from the request body would let anyone attach their payment to
 * somebody else's account — or, more usefully to an attacker, attach
 * nothing and still be told the price.
 */
export async function createCheckoutUrl(request: CheckoutRequest): Promise<string> {
  ensureSetup();

  const variantId = variantIdFor(request.tier, request.period);

  const { data, error } = await createCheckout(storeId(), variantId, {
    checkoutData: {
      email: request.email,
      custom: {
        // Snake case because this is what comes back in
        // `meta.custom_data`, and Lemon Squeezy passes the keys through
        // verbatim. Both are strings — custom data is stringified on
        // their side, and a number here comes back as a string anyway.
        user_id: request.userId,
        email: request.email,
        // Proves this checkout was started by us for this user. Custom
        // data can be set by anyone via a public buy URL, so the id on its
        // own is not evidence of anything — see signCheckoutUserId.
        uid_sig: signCheckoutUserId(request.userId, webhookSecret()),
      },
    },
    productOptions: {
      redirectUrl: request.redirectUrl,
      // Only the variant being bought — otherwise the checkout page offers
      // the product's other variants and the customer can quietly end up
      // on a different plan than the button they clicked.
      enabledVariants: [Number(variantId)],
    },
    checkoutOptions: { embed: false },
  });

  if (error || !data?.data?.attributes?.url) {
    throw new Error(
      `Lemon Squeezy did not return a checkout URL: ${error?.message ?? "no url in response"}`,
    );
  }

  return data.data.attributes.url;
}

/**
 * A pre-signed customer portal URL for one subscription, where the customer
 * can change their card, switch plan, or cancel.
 *
 * Fetched per request and never stored: Lemon Squeezy signs these and they
 * expire 24 hours after issue, so a cached one is a broken link.
 */
export async function customerPortalUrl(
  lemonsqueezySubscriptionId: string,
): Promise<string | null> {
  ensureSetup();

  const { data, error } = await getSubscription(lemonsqueezySubscriptionId);
  if (error || !data) return null;

  return data.data.attributes.urls.customer_portal ?? null;
}

/**
 * The license key issued for an order, if the product has license keys
 * enabled. Returns null when it doesn't — that is the normal case today,
 * not an error, so this never throws: a missing key must not fail the
 * webhook that grants the subscription.
 */
export async function licenseKeyForOrder(orderId: string | number): Promise<string | null> {
  try {
    ensureSetup();
    const { data, error } = await listLicenseKeys({
      filter: { orderId: Number(orderId) },
    });
    if (error || !data?.data?.length) return null;
    return data.data[0].attributes.key ?? null;
  } catch (err) {
    console.error("[billing] license key lookup failed for order", orderId, err);
    return null;
  }
}
