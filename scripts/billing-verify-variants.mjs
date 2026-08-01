// Checks the six LEMONSQUEEZY_VARIANT_* env vars against the live Lemon
// Squeezy store, and the prices in lib/billing/plans.ts against what those
// variants actually charge.
//
// This is the check that catches the failure mode nothing else can: a
// variant id pointing at the wrong product. Types can't see it, the
// webhook can't see it, and the customer only finds out from their bank
// statement. Run it after touching any variant id or price.
//
//   node scripts/billing-verify-variants.mjs

import { register } from "node:module";

import { check, checkEqual, env, section, summarise } from "./billing-env.mjs";

register("./ts-alias-hook.mjs", import.meta.url);
const { PLANS, formatPrice } = await import("../lib/billing/plans.ts");

const API = "https://api.lemonsqueezy.com/v1";
const headers = {
  Authorization: `Bearer ${env.LEMONSQUEEZY_API_KEY}`,
  Accept: "application/vnd.api+json",
};

async function api(path) {
  const response = await fetch(`${API}${path}`, { headers });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

const me = await api("/users/me");
section(`Store — ${me.data.attributes.name} (${me.meta.test_mode ? "TEST MODE" : "LIVE MODE"})`);
check(
  "the API key is a test-mode key",
  me.meta.test_mode === true,
  me.meta.test_mode ? "no real money can move" : "THIS KEY CHARGES REAL CARDS",
);

const expectedInterval = { monthly: "month", yearly: "year" };

for (const plan of PLANS) {
  section(`${plan.name}`);

  for (const period of ["monthly", "yearly"]) {
    const varName = `LEMONSQUEEZY_VARIANT_${plan.tier.toUpperCase()}_${period.toUpperCase()}`;
    const variantId = env[varName];

    if (!variantId) {
      check(`${varName} is set`, false, "missing");
      continue;
    }

    let variant;
    try {
      variant = await api(`/variants/${variantId}`);
    } catch (err) {
      check(`${varName} → variant ${variantId} exists`, false, String(err.message).slice(0, 120));
      continue;
    }

    const attributes = variant.data.attributes;
    const product = await api(`/products/${attributes.product_id}`);
    const productName = product.data.attributes.name;

    check(
      `${varName} → "${productName}"`,
      productName.toLowerCase().startsWith(plan.tier),
      `variant ${variantId}`,
    );
    checkEqual(`  ${plan.tier}/${period} is a subscription`, attributes.is_subscription, true);
    checkEqual(`  ${plan.tier}/${period} bills per ${expectedInterval[period]}`, attributes.interval, expectedInterval[period]);
    checkEqual(
      `  ${plan.tier}/${period} price matches plans.ts (${formatPrice(plan.price[period])})`,
      attributes.price,
      plan.price[period],
    );
    checkEqual(`  ${plan.tier}/${period} product is published`, product.data.attributes.status, "published");
  }
}

process.exit(summarise());
