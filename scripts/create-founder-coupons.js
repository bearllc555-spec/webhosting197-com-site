#!/usr/bin/env node
/**
 * One-time script: provision 100 FOUNDER promo codes in Stripe.
 *
 * What this does:
 *   1. Lists existing promo codes whose code starts with "FOUNDER"
 *   2. Deactivates and deletes them (the old 50-founder set, $50-$1 off)
 *   3. Creates 100 new coupons + promo codes:
 *        FOUNDER1   = $100 off  -> final $97
 *        FOUNDER2   = $99 off   -> final $98
 *        FOUNDER3   = $98 off   -> final $99
 *        ...
 *        FOUNDER50  = $51 off   -> final $146
 *        ...
 *        FOUNDER100 = $1 off    -> final $196
 *
 * Each coupon is one-time-use (max_redemptions=1). When all 100 are redeemed,
 * the splash falls back to standard $197 (the brand-name cap).
 *
 * How to run:
 *   STRIPE_KEY=$(cat ../.local/stripe-key.txt | tr -d '[:space:]') node scripts/create-founder-coupons.js
 *
 * Or read from env:
 *   STRIPE_KEY=sk_live_... node scripts/create-founder-coupons.js
 *
 * The script prompts before deleting; pass --yes to skip confirmation.
 *
 * Idempotency: re-running the script will delete the previously-created
 * 100 codes and recreate them. Safe to re-run if anything goes wrong.
 *
 * Notes:
 * - Uses fetch (Node 18+ required).
 * - Stripe API version pinned to 2023-10-16 to match the Cloudflare Pages
 *   Function /api/founder-coupon.js.
 * - Discount is `amount_off` in cents on USD. Coupons are duration=once
 *   (one-time discount, not recurring), max_redemptions=1.
 */

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2023-10-16";
const TOTAL = 100;
const MAX_DISCOUNT_DOLLARS = 100; // FOUNDER1 starts at $100 off ($97 final)
const PREFIX = "FOUNDER";

const apiKey = process.env.STRIPE_KEY || "";
const skipConfirm = process.argv.includes("--yes");

if (!apiKey) {
  console.error("Missing STRIPE_KEY env var.");
  console.error("Run with: STRIPE_KEY=$(cat .local/stripe-key.txt | tr -d '[:space:]') node scripts/create-founder-coupons.js");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Stripe-Version": STRIPE_VERSION,
  "Content-Type": "application/x-www-form-urlencoded",
};

async function stripeGet(path, params = {}) {
  const url = new URL(STRIPE_API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`GET ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function stripePost(path, body) {
  const r = await fetch(STRIPE_API + path, {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
  });
  if (!r.ok) throw new Error(`POST ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function stripeDelete(path) {
  const r = await fetch(STRIPE_API + path, { method: "DELETE", headers });
  if (!r.ok) throw new Error(`DELETE ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function listAllFounderPromoCodes() {
  const all = [];
  let startingAfter = null;
  for (let page = 0; page < 10; page++) {
    const params = { limit: "100" };
    if (startingAfter) params.starting_after = startingAfter;
    const j = await stripeGet("/promotion_codes", params);
    for (const pc of j.data || []) {
      if (typeof pc.code === "string" && pc.code.startsWith(PREFIX)) all.push(pc);
    }
    if (!j.has_more) break;
    startingAfter = j.data?.[j.data.length - 1]?.id;
    if (!startingAfter) break;
  }
  return all;
}

async function listAllFounderCoupons() {
  const all = [];
  let startingAfter = null;
  for (let page = 0; page < 10; page++) {
    const params = { limit: "100" };
    if (startingAfter) params.starting_after = startingAfter;
    const j = await stripeGet("/coupons", params);
    for (const c of j.data || []) {
      // We tag created coupons with metadata.purpose="webhosting197-founder"
      if (c.metadata?.purpose === "webhosting197-founder") all.push(c);
    }
    if (!j.has_more) break;
    startingAfter = j.data?.[j.data.length - 1]?.id;
    if (!startingAfter) break;
  }
  return all;
}

async function confirm(prompt) {
  if (skipConfirm) return true;
  process.stdout.write(prompt + " [y/N] ");
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      resolve(data.trim().toLowerCase() === "y");
    });
  });
}

async function main() {
  console.log("Connecting to Stripe...");
  const acct = await stripeGet("/account");
  console.log(`Connected: account ${acct.id} (${acct.business_profile?.name || acct.email || "no name"})`);
  console.log(`Mode: ${apiKey.startsWith("sk_test_") ? "TEST" : apiKey.startsWith("sk_live_") ? "LIVE" : "UNKNOWN"}`);

  console.log("\nListing existing FOUNDER* promo codes...");
  const existingPromoCodes = await listAllFounderPromoCodes();
  console.log(`Found ${existingPromoCodes.length} existing FOUNDER promo codes.`);

  console.log("\nListing existing webhosting197-founder coupons (by metadata)...");
  const existingCoupons = await listAllFounderCoupons();
  console.log(`Found ${existingCoupons.length} existing tagged coupons.`);

  if (existingPromoCodes.length > 0 || existingCoupons.length > 0) {
    const ok = await confirm(
      `\nWill deactivate ${existingPromoCodes.length} promo codes and delete ${existingCoupons.length} coupons. Continue?`
    );
    if (!ok) {
      console.log("Aborted by user.");
      process.exit(0);
    }
  }

  // Deactivate promo codes (Stripe doesn't allow deletion, only deactivation).
  for (const pc of existingPromoCodes) {
    if (!pc.active) continue;
    await stripePost(`/promotion_codes/${pc.id}`, { active: "false" });
    console.log(`  deactivated promo code ${pc.code} (id ${pc.id})`);
  }

  // Delete coupons (these are real deletions).
  for (const c of existingCoupons) {
    try {
      await stripeDelete(`/coupons/${c.id}`);
      console.log(`  deleted coupon ${c.id}`);
    } catch (e) {
      console.warn(`  could not delete coupon ${c.id}: ${e.message}`);
    }
  }

  // Provision new 100 founders.
  console.log(`\nCreating ${TOTAL} new founder coupons + promo codes...`);
  for (let n = 1; n <= TOTAL; n++) {
    const dollarsOff = MAX_DISCOUNT_DOLLARS - (n - 1); // 100, 99, 98, ..., 1
    const finalPrice = 197 - dollarsOff;
    const code = `${PREFIX}${n}`;

    // Create coupon
    const coupon = await stripePost("/coupons", {
      name: `webhosting197 Founder #${n}`,
      amount_off: String(dollarsOff * 100), // cents
      currency: "usd",
      duration: "once",
      max_redemptions: "1",
      "metadata[purpose]": "webhosting197-founder",
      "metadata[founder_number]": String(n),
      "metadata[final_price_dollars]": String(finalPrice),
    });

    // Create promo code that references the coupon
    const promo = await stripePost("/promotion_codes", {
      coupon: coupon.id,
      code: code,
      max_redemptions: "1",
      "metadata[purpose]": "webhosting197-founder",
      "metadata[founder_number]": String(n),
    });

    console.log(`  ${code}: $${dollarsOff} off -> final $${finalPrice} (coupon ${coupon.id}, promo ${promo.id})`);
  }

  console.log("\nDone. The splash /api/founder-coupon endpoint will now serve climbing prices $97 -> $196 over 100 founders.");
}

main().catch((err) => {
  console.error("\nERROR:", err.message);
  process.exit(1);
});
