// End-to-end verification of the Lemon Squeezy webhook route.
//
// Posts real, correctly signed payloads at a running dev server and reads
// the resulting rows straight out of Supabase, so what it proves is what
// the database actually contains — not what the handler returned and not
// what the types say. Run it with the dev server up:
//
//   node scripts/billing-webhook-test.mjs
//
// It creates one throwaway auth user, exercises every handled event
// against it, and deletes the user (and, by cascade, every row it made) at
// the end — including when an assertion fails.

import crypto from "node:crypto";
import { register } from "node:module";

import {
  check,
  checkEqual,
  checkSameInstant,
  createAuthUser,
  deleteAuthUser,
  env,
  section,
  selectRows,
  summarise,
} from "./billing-env.mjs";

register("./ts-alias-hook.mjs", import.meta.url);

// The real attribution signer, not a copy of it — if the app's scheme
// changes and this harness isn't updated, every attribution assertion
// fails loudly instead of silently testing the wrong thing.
const { signCheckoutUserId } = await import("../lib/billing/signature.ts");

const BASE_URL = process.env.BILLING_TEST_BASE_URL ?? "http://localhost:3000";
const WEBHOOK_URL = `${BASE_URL}/api/webhooks/lemonsqueezy`;
const SECRET = env.LEMONSQUEEZY_WEBHOOK_SECRET;

const STORE_ID = 443272;
const VARIANT = {
  basic_monthly: Number(env.LEMONSQUEEZY_VARIANT_BASIC_MONTHLY),
  basic_yearly: Number(env.LEMONSQUEEZY_VARIANT_BASIC_YEARLY),
  pro_monthly: Number(env.LEMONSQUEEZY_VARIANT_PRO_MONTHLY),
  pro_yearly: Number(env.LEMONSQUEEZY_VARIANT_PRO_YEARLY),
  max_monthly: Number(env.LEMONSQUEEZY_VARIANT_MAX_MONTHLY),
  max_yearly: Number(env.LEMONSQUEEZY_VARIANT_MAX_YEARLY),
};

// Distinct ids per run so a previous run's leftovers can never satisfy an
// assertion in this one.
const RUN = Date.now();
const SUBSCRIPTION_A = String(900000000 + (RUN % 1000000));
const SUBSCRIPTION_B = String(910000000 + (RUN % 1000000));
const CUSTOMER_ID = String(800000000 + (RUN % 1000000));

const IN_A_MONTH = new Date(Date.now() + 30 * 86400_000).toISOString();
const IN_A_YEAR = new Date(Date.now() + 365 * 86400_000).toISOString();
const YESTERDAY = new Date(Date.now() - 86400_000).toISOString();

let userId = null;
let invoiceCounter = 0;

const PROBE_EMAIL = "billing-probe@netherite-verify.invalid";

/**
 * The custom data a checkout started by our own route carries: the user id
 * plus a keyed digest of it. Lemon Squeezy lets anybody put arbitrary
 * custom data on a public buy URL, so the digest is what distinguishes a
 * checkout we started from one somebody else did.
 */
function signedCustomData(forUserId = userId) {
  return {
    user_id: forUserId,
    email: PROBE_EMAIL,
    uid_sig: signCheckoutUserId(forUserId, SECRET),
  };
}

// ── Payload builders ────────────────────────────────────────────────────
// Shaped to match what Lemon Squeezy actually sends. The two families are
// deliberately different: every `subscription_payment_*` event carries a
// `subscription-invoices` object, not a subscription.

function subscriptionPayload(eventName, overrides = {}) {
  const {
    subscriptionId = SUBSCRIPTION_A,
    variantId = VARIANT.pro_monthly,
    status = "active",
    renewsAt = IN_A_MONTH,
    endsAt = null,
    customData = signedCustomData(),
    orderId = 3000001,
  } = overrides;

  return {
    meta: { test_mode: true, event_name: eventName, custom_data: customData },
    data: {
      type: "subscriptions",
      id: String(subscriptionId),
      attributes: {
        store_id: STORE_ID,
        customer_id: Number(CUSTOMER_ID),
        order_id: orderId,
        order_item_id: 4000001,
        product_id: 1260195,
        variant_id: variantId,
        product_name: "Pro",
        variant_name: "Default",
        user_name: "Billing Probe",
        user_email: "billing-probe@netherite-verify.invalid",
        status,
        status_formatted: status,
        card_brand: "visa",
        card_last_four: "4242",
        pause: null,
        cancelled: status === "cancelled",
        trial_ends_at: null,
        billing_anchor: 1,
        first_subscription_item: {
          id: 5000001,
          subscription_id: Number(subscriptionId),
          price_id: 6000001,
          quantity: 1,
        },
        urls: {
          update_payment_method: "https://netherite.lemonsqueezy.com/subscription/x/payment-details",
          customer_portal: "https://netherite.lemonsqueezy.com/billing?expires=1",
          customer_portal_update_subscription: "https://netherite.lemonsqueezy.com/billing/x/update",
        },
        renews_at: renewsAt,
        ends_at: endsAt,
        created_at: YESTERDAY,
        updated_at: new Date().toISOString(),
        test_mode: true,
      },
    },
  };
}

function invoicePayload(eventName, overrides = {}) {
  const {
    invoiceId = String(700000000 + RUN % 1000000 + ++invoiceCounter),
    subscriptionId = SUBSCRIPTION_A,
    total = 2000,
    status = "paid",
    refunded = false,
    refundedAt = null,
    billingReason = "renewal",
    customData = signedCustomData(),
    createdAt = new Date().toISOString(),
  } = overrides;

  return {
    meta: { test_mode: true, event_name: eventName, custom_data: customData },
    data: {
      type: "subscription-invoices",
      id: String(invoiceId),
      attributes: {
        store_id: STORE_ID,
        subscription_id: Number(subscriptionId),
        customer_id: Number(CUSTOMER_ID),
        user_name: "Billing Probe",
        user_email: "billing-probe@netherite-verify.invalid",
        billing_reason: billingReason,
        card_brand: "visa",
        card_last_four: "4242",
        currency: "USD",
        currency_rate: "1.0000",
        status,
        status_formatted: status,
        refunded,
        refunded_at: refundedAt,
        subtotal: total,
        discount_total: 0,
        tax: 0,
        total,
        subtotal_usd: total,
        discount_total_usd: 0,
        tax_usd: 0,
        total_usd: total,
        created_at: createdAt,
        updated_at: createdAt,
        test_mode: true,
      },
    },
  };
}

// ── Transport ───────────────────────────────────────────────────────────

function sign(body, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/** Posts a payload with a valid signature over exactly the bytes sent. */
async function post(payload, { signature, secret, omitSignature = false } = {}) {
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  if (!omitSignature) {
    headers["X-Signature"] = signature ?? sign(body, secret ?? SECRET);
  }

  const response = await fetch(WEBHOOK_URL, { method: "POST", headers, body });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }
  return { status: response.status, body: json, text };
}

// ── Reads ───────────────────────────────────────────────────────────────

async function subscriptionRow() {
  const rows = await selectRows("subscriptions", `user_id=eq.${userId}&select=*`);
  return rows[0] ?? null;
}

async function paymentRows() {
  const rows = await selectRows(
    "payment_history",
    `user_id=eq.${userId}&select=*&order=paid_at.asc`,
  );
  return rows;
}

/** A comparable snapshot of everything that decides entitlement. */
function entitlementSnapshot(row) {
  return row
    ? JSON.stringify({
        tier: row.tier,
        status: row.status,
        billing_period: row.billing_period,
        current_period_end: row.current_period_end,
      })
    : "null";
}

// ── The run ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`Webhook under test: ${WEBHOOK_URL}`);

  // Fail fast and clearly if the dev server isn't up, rather than
  // reporting every assertion as a failure.
  try {
    await fetch(BASE_URL, { method: "HEAD" });
  } catch {
    console.error(`\nCan't reach ${BASE_URL}. Start the dev server first: npm run dev`);
    process.exit(2);
  }

  userId = await createAuthUser(`billing-probe-${RUN}@netherite-verify.invalid`);
  console.log(`Throwaway user: ${userId}\n`);

  // ── 1. Signature verification ─────────────────────────────────────────
  // Every one of these must be refused *before* the payload is parsed.
  // They all carry a body that would otherwise grant a Max subscription,
  // so the DB check at the end of the section is the real assertion.
  section("1. Signature verification — nothing gets through unsigned");

  const forged = subscriptionPayload("subscription_created", {
    variantId: VARIANT.max_yearly,
  });

  const noSignature = await post(forged, { omitSignature: true });
  checkEqual("no X-Signature header is rejected", noSignature.status, 401);

  const garbage = await post(forged, { signature: "not-a-signature" });
  checkEqual("malformed signature is rejected", garbage.status, 401);

  const wrongLength = await post(forged, { signature: "ab".repeat(16) });
  checkEqual("short hex signature is rejected", wrongLength.status, 401);

  const wrongSecret = await post(forged, { secret: `${SECRET}x` });
  checkEqual("signature made with the wrong secret is rejected", wrongSecret.status, 401);

  // The signature is valid — for a *different* body. This is the case a
  // naive "re-serialise then compare" implementation lets through.
  const tampered = await (async () => {
    const original = JSON.stringify(forged);
    const signature = sign(original);
    const modified = JSON.stringify({
      ...forged,
      meta: { ...forged.meta, custom_data: { user_id: userId, email: "attacker@example.com" } },
    });
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": signature },
      body: modified,
    });
    return response.status;
  })();
  checkEqual("valid signature over a different body is rejected", tampered, 401);

  const uppercase = await post(forged, { signature: sign(JSON.stringify(forged)).toUpperCase() });
  checkEqual("correct signature in uppercase hex is accepted", uppercase.status, 200);

  // That last one was a real subscription_created for max_yearly. Undo it
  // so the lifecycle section starts from nothing.
  await selectRows("subscriptions", `user_id=eq.${userId}&select=user_id`);
  const { deleteRows } = await import("./billing-env.mjs");
  await deleteRows("subscriptions", `user_id=eq.${userId}`);

  section("1b. Attribution — a genuine event can't be aimed at another account");

  // These payloads are signed correctly, so they are indistinguishable
  // from a real Lemon Squeezy delivery. What makes them an attack is the
  // custom_data: Lemon Squeezy accepts custom data as query parameters on
  // a product's public buy URL, so anyone can buy the cheapest plan while
  // naming somebody else's user id. If that were honoured, the purchase
  // would overwrite the victim's subscription row — and a refund would
  // then drop them to free.

  const unsigned = await post(
    subscriptionPayload("subscription_created", {
      variantId: VARIANT.basic_monthly,
      customData: { user_id: userId, email: PROBE_EMAIL },
    }),
  );
  checkEqual("custom_data with no uid_sig is not attributed", unsigned.status, 202);
  check("and writes no subscription row", (await subscriptionRow()) === null);

  const badSig = await post(
    subscriptionPayload("subscription_created", {
      variantId: VARIANT.basic_monthly,
      customData: { user_id: userId, email: PROBE_EMAIL, uid_sig: "0".repeat(64) },
    }),
  );
  checkEqual("custom_data with a forged uid_sig is not attributed", badSig.status, 202);
  check("and still writes no subscription row", (await subscriptionRow()) === null);

  // The attacker's own signature, replayed against a different user id —
  // the exact move the digest has to stop.
  const otherUserId = "22222222-3333-4444-8555-666666666666";
  const stolenSig = await post(
    subscriptionPayload("subscription_created", {
      variantId: VARIANT.basic_monthly,
      customData: {
        user_id: userId,
        email: PROBE_EMAIL,
        uid_sig: signCheckoutUserId(otherUserId, SECRET),
      },
    }),
  );
  checkEqual("a signature issued for a different user id is refused", stolenSig.status, 202);
  check("and still writes no subscription row", (await subscriptionRow()) === null);

  section("2. subscription_created");

  const created = await post(
    subscriptionPayload("subscription_created", { variantId: VARIANT.pro_monthly }),
  );
  checkEqual("returns 200", created.status, 200);

  let row = await subscriptionRow();
  check("a subscriptions row exists", row !== null);
  checkEqual("tier is pro", row?.tier, "pro");
  checkEqual("billing_period is monthly", row?.billing_period, "monthly");
  checkEqual("status is active", row?.status, "active");
  checkEqual("lemonsqueezy_subscription_id stored", row?.lemonsqueezy_subscription_id, SUBSCRIPTION_A);
  checkEqual("lemonsqueezy_customer_id stored", row?.lemonsqueezy_customer_id, CUSTOMER_ID);
  checkSameInstant("current_period_end is renews_at", row?.current_period_end, IN_A_MONTH);
  check(
    "license_key column is present and null (no license keys on this product)",
    row !== null && "license_key" in row && row.license_key === null,
    `license_key=${JSON.stringify(row?.license_key)}`,
  );

  // Defence in depth behind the attribution digest: even a correctly
  // signed second purchase must not quietly replace a plan that is
  // currently granting access.
  const liveSnapshot = entitlementSnapshot(await subscriptionRow());
  const replacement = await post(
    subscriptionPayload("subscription_created", {
      subscriptionId: String(999000001),
      variantId: VARIANT.basic_monthly,
    }),
  );
  checkEqual("a second purchase can't replace a live subscription", replacement.status, 202);
  checkEqual(
    "the live subscription is untouched",
    entitlementSnapshot(await subscriptionRow()),
    liveSnapshot,
  );

  section("3. subscription_payment_success — history only, never entitlement");

  const beforePayment = entitlementSnapshot(await subscriptionRow());

  const firstInvoiceId = String(710000000 + (RUN % 1000000));
  const paymentSuccess = await post(
    invoicePayload("subscription_payment_success", {
      invoiceId: firstInvoiceId,
      total: 2000,
      billingReason: "initial",
    }),
  );
  checkEqual("returns 200", paymentSuccess.status, 200);

  let payments = await paymentRows();
  checkEqual("one payment_history row written", payments.length, 1);
  checkEqual("amount recorded in cents", payments[0]?.amount, 2000);
  checkEqual("status is success", payments[0]?.status, "success");
  checkEqual("refunded defaults to false", payments[0]?.refunded, false);
  checkEqual("subscription_id recorded", payments[0]?.subscription_id, SUBSCRIPTION_A);
  check("paid_at recorded", Boolean(payments[0]?.paid_at), payments[0]?.paid_at);

  checkEqual(
    "entitlement is byte-for-byte unchanged by payment_success",
    entitlementSnapshot(await subscriptionRow()),
    beforePayment,
  );

  // Idempotency: Lemon Squeezy retries deliveries.
  const replay = await post(
    invoicePayload("subscription_payment_success", {
      invoiceId: firstInvoiceId,
      total: 2000,
      billingReason: "initial",
    }),
  );
  checkEqual("a redelivered invoice returns 200", replay.status, 200);
  payments = await paymentRows();
  checkEqual("redelivery does not duplicate the row", payments.length, 1);

  section("4. subscription_updated — upgrade, plan switch, reactivation");

  const upgraded = await post(
    subscriptionPayload("subscription_updated", {
      variantId: VARIANT.max_yearly,
      status: "active",
      renewsAt: IN_A_YEAR,
    }),
  );
  checkEqual("returns 200", upgraded.status, 200);

  row = await subscriptionRow();
  checkEqual("tier follows the new variant", row?.tier, "max");
  checkEqual("billing_period follows the new variant", row?.billing_period, "yearly");
  checkEqual("status stays active", row?.status, "active");
  checkSameInstant("current_period_end updated", row?.current_period_end, IN_A_YEAR);

  const downgraded = await post(
    subscriptionPayload("subscription_updated", {
      variantId: VARIANT.basic_monthly,
      status: "active",
      renewsAt: IN_A_MONTH,
    }),
  );
  checkEqual("downgrade returns 200", downgraded.status, 200);
  row = await subscriptionRow();
  checkEqual("tier follows the downgrade", row?.tier, "basic");
  checkEqual("billing_period follows the downgrade", row?.billing_period, "monthly");

  section("5. subscription_payment_failed — past_due, access retained");

  const tierBeforeFailure = (await subscriptionRow())?.tier;
  const failed = await post(
    invoicePayload("subscription_payment_failed", { status: "pending", total: 999 }),
  );
  checkEqual("returns 200", failed.status, 200);

  row = await subscriptionRow();
  checkEqual("status is past_due", row?.status, "past_due");
  checkEqual("tier is NOT revoked", row?.tier, tierBeforeFailure);
  checkEqual("no payment_history row for a failed charge", (await paymentRows()).length, 1);

  const recovered = await post(
    subscriptionPayload("subscription_updated", {
      variantId: VARIANT.basic_monthly,
      status: "active",
    }),
  );
  checkEqual("recovery returns 200", recovered.status, 200);
  checkEqual("status back to active", (await subscriptionRow())?.status, "active");

  section("6. subscription_cancelled — access until current_period_end");

  const cancelled = await post(
    subscriptionPayload("subscription_cancelled", {
      variantId: VARIANT.basic_monthly,
      status: "cancelled",
      endsAt: IN_A_MONTH,
    }),
  );
  checkEqual("returns 200", cancelled.status, 200);

  row = await subscriptionRow();
  checkEqual("status is cancelled", row?.status, "cancelled");
  checkEqual("tier is retained", row?.tier, "basic");
  checkSameInstant("current_period_end is ends_at", row?.current_period_end, IN_A_MONTH);

  section("7. renewal payment while cancelled must not resurrect the plan");

  const cancelledSnapshot = entitlementSnapshot(await subscriptionRow());
  const renewal = await post(
    invoicePayload("subscription_payment_success", { total: 999, billingReason: "renewal" }),
  );
  checkEqual("returns 200", renewal.status, 200);
  checkEqual("a second payment_history row is written", (await paymentRows()).length, 2);
  checkEqual(
    "status stays cancelled and tier stays put",
    entitlementSnapshot(await subscriptionRow()),
    cancelledSnapshot,
  );

  section("8. subscription_expired — back to free");

  const expired = await post(
    subscriptionPayload("subscription_expired", {
      variantId: VARIANT.basic_monthly,
      status: "expired",
      endsAt: YESTERDAY,
    }),
  );
  checkEqual("returns 200", expired.status, 200);

  row = await subscriptionRow();
  checkEqual("tier is free", row?.tier, "free");
  checkEqual("status is expired", row?.status, "expired");
  checkEqual("billing_period cleared", row?.billing_period, null);

  section("9. subscription_payment_refunded — immediate revocation");

  // Fresh subscription so the refund has something live to revoke.
  await post(
    subscriptionPayload("subscription_created", {
      subscriptionId: SUBSCRIPTION_B,
      variantId: VARIANT.max_monthly,
      renewsAt: IN_A_MONTH,
    }),
  );
  row = await subscriptionRow();
  checkEqual("resubscribed at max", row?.tier, "max");
  checkEqual("row now points at the new subscription", row?.lemonsqueezy_subscription_id, SUBSCRIPTION_B);

  const refundInvoiceId = String(720000000 + (RUN % 1000000));
  await post(
    invoicePayload("subscription_payment_success", {
      invoiceId: refundInvoiceId,
      subscriptionId: SUBSCRIPTION_B,
      total: 10000,
      billingReason: "initial",
    }),
  );
  checkEqual("payment recorded before refund", (await paymentRows()).length, 3);

  const refunded = await post(
    invoicePayload("subscription_payment_refunded", {
      invoiceId: refundInvoiceId,
      subscriptionId: SUBSCRIPTION_B,
      total: 10000,
      status: "refunded",
      refunded: true,
      refundedAt: new Date().toISOString(),
    }),
  );
  checkEqual("returns 200", refunded.status, 200);

  row = await subscriptionRow();
  checkEqual("tier is free immediately", row?.tier, "free");
  checkEqual("status is refunded", row?.status, "refunded");
  check(
    "current_period_end is not what keeps access — status alone revokes it",
    row?.status === "refunded",
    `current_period_end=${row?.current_period_end}`,
  );

  payments = await paymentRows();
  const refundedRow = payments.find((p) => p.lemonsqueezy_invoice_id === refundInvoiceId);
  checkEqual("still three payment rows (marked, not duplicated)", payments.length, 3);
  checkEqual("matching payment row is refunded", refundedRow?.refunded, true);
  checkEqual("matching payment row status is refunded", refundedRow?.status, "refunded");
  checkEqual("refunded amount preserved", refundedRow?.amount, 10000);
  check(
    "the other payment rows are untouched",
    payments.filter((p) => p.refunded).length === 1,
    `${payments.filter((p) => p.refunded).length} of ${payments.length} rows refunded`,
  );

  section("10. a refund is terminal — later events can't undo it");

  const afterRefund = entitlementSnapshot(await subscriptionRow());

  const lateUpdate = await post(
    subscriptionPayload("subscription_updated", {
      subscriptionId: SUBSCRIPTION_B,
      variantId: VARIANT.max_monthly,
      status: "active",
    }),
  );
  checkEqual("a later subscription_updated is a no-op (202)", lateUpdate.status, 202);
  checkEqual(
    "entitlement unchanged after subscription_updated",
    entitlementSnapshot(await subscriptionRow()),
    afterRefund,
  );

  const lateRenewal = await post(
    invoicePayload("subscription_payment_success", {
      subscriptionId: SUBSCRIPTION_B,
      total: 10000,
      billingReason: "renewal",
    }),
  );
  checkEqual("a later renewal payment still returns 200", lateRenewal.status, 200);
  checkEqual(
    "entitlement unchanged after a renewal payment",
    entitlementSnapshot(await subscriptionRow()),
    afterRefund,
  );

  section("11. events for a superseded subscription are ignored");

  // SUBSCRIPTION_A was replaced by SUBSCRIPTION_B in section 9. Its
  // lifecycle events must not touch the current row.
  const stale = await post(
    subscriptionPayload("subscription_expired", {
      subscriptionId: SUBSCRIPTION_A,
      status: "expired",
      endsAt: YESTERDAY,
    }),
  );
  checkEqual("stale subscription_expired is a no-op (202)", stale.status, 202);
  checkEqual(
    "entitlement unchanged by the stale event",
    entitlementSnapshot(await subscriptionRow()),
    afterRefund,
  );

  section("12. unknown and unhandled events");

  const unhandled = await post({
    meta: { event_name: "order_created", custom_data: { user_id: userId } },
    data: { type: "orders", id: "1", attributes: { test_mode: true } },
  });
  checkEqual("an unsubscribed event is acknowledged, not retried", unhandled.status, 200);
  checkEqual("and is reported as unhandled", unhandled.body?.handled, false);

  const unknownVariant = await post(
    subscriptionPayload("subscription_created", {
      subscriptionId: String(999999999),
      variantId: 111111,
    }),
  );
  checkEqual(
    "an unmapped variant is a 500 so the delivery retries after a config fix",
    unknownVariant.status,
    500,
  );
}

const exitCode = await main()
  .then(() => summarise())
  .catch((err) => {
    console.error("\nHarness error:", err);
    return 1;
  })
  .finally(async () => {
    if (userId) {
      // Deleting the auth user cascades to subscriptions and
      // payment_history, so nothing this script made survives it.
      await deleteAuthUser(userId);
      console.log(`\nCleaned up throwaway user ${userId}.`);
    }
  });

process.exit(exitCode);
