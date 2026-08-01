// Proves the RLS on the billing tables from the outside, as a real logged-in
// user rather than as the service role.
//
// The migration's claim is that a user can read their own row and write
// nothing at all. That claim is only worth anything if it is tested with an
// actual user JWT against the actual PostgREST endpoint — which is what this
// does. It creates two users, gives both a subscription, signs in as one,
// and then tries every read and write a hostile client would try.
//
//   node scripts/billing-rls-test.mjs

import {
  check,
  checkEqual,
  deleteAuthUser,
  env,
  section,
  summarise,
  SUPABASE_URL,
  SERVICE_KEY,
} from "./billing-env.mjs";

const ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const RUN = Date.now();

const service = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

/** Creates a confirmed user with a password so we can obtain a real JWT. */
async function createUserWithPassword(email, password) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: service,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`create user failed: ${JSON.stringify(body)}`);
  return body.id;
}

async function signIn(email, password) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`sign in failed: ${JSON.stringify(body)}`);
  return body.access_token;
}

/** A request as the signed-in user: anon key + their JWT, exactly like the browser. */
function asUser(token, extra = {}) {
  return {
    apikey: ANON_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function rest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, options);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* empty body */
  }
  return { status: response.status, body: json, text };
}

const victimEmail = `rls-victim-${RUN}@netherite-verify.invalid`;
const attackerEmail = `rls-attacker-${RUN}@netherite-verify.invalid`;
const password = `Pw-${RUN}-${Math.random().toString(36).slice(2)}`;

let victimId = null;
let attackerId = null;

async function main() {
  victimId = await createUserWithPassword(victimEmail, password);
  attackerId = await createUserWithPassword(attackerEmail, password);
  console.log(`victim   ${victimId}\nattacker ${attackerId}\n`);

  // Seed both users with a paid subscription and a payment, as the webhook
  // would. Service role, so RLS does not apply here.
  const periodEnd = new Date(Date.now() + 30 * 86400_000).toISOString();
  for (const [id, tier] of [
    [victimId, "max"],
    [attackerId, "basic"],
  ]) {
    await rest("subscriptions", {
      method: "POST",
      headers: service,
      body: JSON.stringify({
        user_id: id,
        lemonsqueezy_customer_id: `cus_${id.slice(0, 8)}`,
        lemonsqueezy_subscription_id: `sub_${id.slice(0, 8)}`,
        tier,
        billing_period: "monthly",
        status: "active",
        current_period_end: periodEnd,
        license_key: `LICENSE-${id.slice(0, 8)}`,
      }),
    });
    await rest("payment_history", {
      method: "POST",
      headers: service,
      body: JSON.stringify({
        user_id: id,
        subscription_id: `sub_${id.slice(0, 8)}`,
        lemonsqueezy_invoice_id: `inv_${id.slice(0, 8)}_${RUN}`,
        amount: 10000,
        currency: "USD",
        status: "success",
        paid_at: new Date().toISOString(),
      }),
    });
  }

  const token = await signIn(attackerEmail, password);

  section("Reads — you see your own row and no one else's");

  const ownSubs = await rest("subscriptions?select=*", { headers: asUser(token) });
  checkEqual("selecting subscriptions succeeds", ownSubs.status, 200);
  checkEqual("returns exactly one row", ownSubs.body?.length, 1);
  checkEqual("and it is the caller's own", ownSubs.body?.[0]?.user_id, attackerId);
  checkEqual("with the caller's own tier", ownSubs.body?.[0]?.tier, "basic");

  const targeted = await rest(`subscriptions?user_id=eq.${victimId}&select=*`, {
    headers: asUser(token),
  });
  checkEqual("asking for another user's row by id returns nothing", targeted.body?.length, 0);

  const licencePeek = await rest(
    `subscriptions?select=license_key&license_key=like.LICENSE-*`,
    { headers: asUser(token) },
  );
  check(
    "another user's license key is not readable",
    !JSON.stringify(licencePeek.body ?? []).includes(victimId.slice(0, 8)),
    JSON.stringify(licencePeek.body),
  );

  const ownPayments = await rest("payment_history?select=*", { headers: asUser(token) });
  checkEqual("selecting payment_history succeeds", ownPayments.status, 200);
  checkEqual("returns only the caller's payments", ownPayments.body?.length, 1);
  checkEqual("and they belong to the caller", ownPayments.body?.[0]?.user_id, attackerId);

  const victimPayments = await rest(`payment_history?user_id=eq.${victimId}&select=*`, {
    headers: asUser(token),
  });
  checkEqual("another user's payments return nothing", victimPayments.body?.length, 0);

  section("Writes — the whole point: a user cannot buy themselves a tier");

  // PostgREST returns 200 with an empty array when RLS filters the rows out
  // of an UPDATE, so the row has to be re-read to prove nothing changed.
  const selfPromote = await rest(`subscriptions?user_id=eq.${attackerId}`, {
    method: "PATCH",
    headers: asUser(token, { Prefer: "return=representation" }),
    body: JSON.stringify({ tier: "max", status: "active" }),
  });
  check(
    "updating your own tier is refused or silently filtered",
    selfPromote.status === 401 ||
      selfPromote.status === 403 ||
      (Array.isArray(selfPromote.body) && selfPromote.body.length === 0),
    `HTTP ${selfPromote.status} ${selfPromote.text.slice(0, 80)}`,
  );

  const afterPromote = await rest(
    `subscriptions?user_id=eq.${attackerId}&select=tier,status`,
    { headers: service },
  );
  checkEqual("tier is still basic in the database", afterPromote.body?.[0]?.tier, "basic");

  const promoteEveryone = await rest("subscriptions?tier=neq.zzz", {
    method: "PATCH",
    headers: asUser(token, { Prefer: "return=representation" }),
    body: JSON.stringify({ tier: "max" }),
  });
  check(
    "a blanket update across all rows changes nothing",
    promoteEveryone.status >= 400 ||
      (Array.isArray(promoteEveryone.body) && promoteEveryone.body.length === 0),
    `HTTP ${promoteEveryone.status}`,
  );

  const allTiers = await rest("subscriptions?select=user_id,tier", { headers: service });
  checkEqual(
    "the victim is still on max",
    allTiers.body?.find((r) => r.user_id === victimId)?.tier,
    "max",
  );

  const insertSelf = await rest("subscriptions", {
    method: "POST",
    headers: asUser(token),
    body: JSON.stringify({ user_id: attackerId, tier: "max", status: "active" }),
  });
  check("inserting a subscription row is refused", insertSelf.status >= 400, `HTTP ${insertSelf.status}`);

  const deleteSelf = await rest(`subscriptions?user_id=eq.${attackerId}`, {
    method: "DELETE",
    headers: asUser(token, { Prefer: "return=representation" }),
  });
  check(
    "deleting your subscription row changes nothing",
    deleteSelf.status >= 400 || (Array.isArray(deleteSelf.body) && deleteSelf.body.length === 0),
    `HTTP ${deleteSelf.status}`,
  );
  const stillThere = await rest(`subscriptions?user_id=eq.${attackerId}&select=user_id`, {
    headers: service,
  });
  checkEqual("the row is still there", stillThere.body?.length, 1);

  const unrefund = await rest(`payment_history?user_id=eq.${attackerId}`, {
    method: "PATCH",
    headers: asUser(token, { Prefer: "return=representation" }),
    body: JSON.stringify({ refunded: false, amount: 1 }),
  });
  check(
    "rewriting your own payment history is refused",
    unrefund.status >= 400 || (Array.isArray(unrefund.body) && unrefund.body.length === 0),
    `HTTP ${unrefund.status}`,
  );

  const insertPayment = await rest("payment_history", {
    method: "POST",
    headers: asUser(token),
    body: JSON.stringify({
      user_id: attackerId,
      amount: 999999,
      status: "success",
      paid_at: new Date().toISOString(),
    }),
  });
  check("inventing a payment is refused", insertPayment.status >= 400, `HTTP ${insertPayment.status}`);

  const promoteViaUserTiers = await rest("user_tiers", {
    method: "POST",
    headers: asUser(token),
    body: JSON.stringify({ user_id: attackerId, tier: "max" }),
  });
  check(
    "the manual-override table is not writable either",
    promoteViaUserTiers.status >= 400,
    `HTTP ${promoteViaUserTiers.status}`,
  );

  section("Anonymous — no session, no rows");

  const anonHeaders = { apikey: ANON_KEY, "Content-Type": "application/json" };

  const anonSubs = await rest("subscriptions?select=*", { headers: anonHeaders });
  check(
    "an anonymous read returns no subscriptions",
    anonSubs.status >= 400 || (Array.isArray(anonSubs.body) && anonSubs.body.length === 0),
    `HTTP ${anonSubs.status} ${JSON.stringify(anonSubs.body)?.slice(0, 60)}`,
  );

  const anonPayments = await rest("payment_history?select=*", { headers: anonHeaders });
  check(
    "an anonymous read returns no payments",
    anonPayments.status >= 400 || (Array.isArray(anonPayments.body) && anonPayments.body.length === 0),
    `HTTP ${anonPayments.status}`,
  );

  const anonWrite = await rest("subscriptions", {
    method: "POST",
    headers: anonHeaders,
    body: JSON.stringify({ user_id: victimId, tier: "max", status: "active" }),
  });
  check("an anonymous write is refused", anonWrite.status >= 400, `HTTP ${anonWrite.status}`);
}

const exitCode = await main()
  .then(() => summarise())
  .catch((err) => {
    console.error("\nHarness error:", err);
    return 1;
  })
  .finally(async () => {
    for (const id of [victimId, attackerId]) {
      if (id) await deleteAuthUser(id);
    }
    console.log("\nCleaned up both throwaway users.");
  });

process.exit(exitCode);
