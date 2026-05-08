/**
 * GET /api/founder-coupon
 *
 * Returns the next-available founder pricing for the splash counter +
 * checkout-CTA URL. Drives the climbing-price founder mechanic: each of
 * the 50 FOUNDER promotion codes is single-use; this endpoint surfaces
 * the lowest-numbered unredeemed one. Once all 50 are redeemed, founder
 * pricing closes and standard $197 takes over.
 *
 * Response shape:
 * {
 *   founderActive: boolean,        // true while at least one FOUNDER code is unredeemed
 *   code: string | null,           // e.g., "FOUNDER12" — null when all redeemed
 *   currentPrice: number,          // dollars; 147..196 while active, 197 once closed
 *   claimedCount: number,          // how many founder slots are taken (0..50)
 *   maxFounders: number,           // 50, surfaced for the UI
 *   reservedUntil: string | null   // ISO timestamp; null while we trust Stripe-side enforcement
 * }
 *
 * Implementation notes:
 * - Reads from Stripe directly (single source of truth). No KV / D1 needed.
 * - Filters promotion codes by code-prefix `FOUNDER` so any unrelated codes
 *   on the account don't pollute the founder logic.
 * - "Active and unredeemed" = `active === true && times_redeemed === 0`.
 *   Stripe's max_redemptions=1 setting flips active to false on redemption,
 *   so checking active is sufficient and times_redeemed is belt-and-suspenders.
 * - Cache-Control: 30s public — at <50 founders this is plenty fast and
 *   protects us from a thundering herd on a viral splash moment without
 *   making the counter feel stale.
 * - On any Stripe error or missing key, we fail soft to standard pricing.
 *   Splash never breaks; user can always check out at $197.
 */

const FOUNDER_PREFIX = "FOUNDER";
const STANDARD_PRICE = 197;
const MAX_FOUNDERS = 100;
const STRIPE_API_VERSION = "2023-10-16";
const CACHE_SECONDS = 30;

export async function onRequestGet({ env }) {
  const apiKey = env.STRIPE_RUNTIME_KEY;

  if (!apiKey) {
    return softFallback("no-runtime-key");
  }

  try {
    const promoCodes = await fetchAllFounderPromoCodes(apiKey);

    // Parse founder numbers and sort.
    const allFounder = promoCodes
      .map((pc) => ({ ...pc, n: parseFounderNumber(pc.code) }))
      .filter((pc) => pc.n !== null);

    // Active + unredeemed founder codes (the ones still claimable).
    const available = allFounder
      .filter((pc) => pc.active && pc.times_redeemed === 0)
      .sort((a, b) => a.n - b.n);

    const next = available[0];
    // Self-adjusting math: claimedCount = total existing founder codes minus available.
    // If only 50 codes exist in Stripe but MAX_FOUNDERS=100, claimedCount tracks
    // actual redemptions out of what was provisioned — not "missing slots = claimed."
    const claimedCount = allFounder.length - available.length;

    if (!next) {
      // All 50 redeemed — founder pricing closed.
      return jsonResponse({
        founderActive: false,
        code: null,
        currentPrice: STANDARD_PRICE,
        claimedCount: MAX_FOUNDERS,
        maxFounders: MAX_FOUNDERS,
        reservedUntil: null,
      });
    }

    // Coupon details are inlined on the promotion code object.
    const dollarsOff = (next.coupon?.amount_off ?? 0) / 100;
    const currentPrice = STANDARD_PRICE - dollarsOff;

    return jsonResponse({
      founderActive: true,
      code: next.code,
      currentPrice,
      claimedCount,
      maxFounders: MAX_FOUNDERS,
      reservedUntil: null,
    });
  } catch (err) {
    return softFallback("stripe-error", err.message);
  }
}

/* ---------- helpers ---------- */

function parseFounderNumber(code) {
  if (typeof code !== "string" || !code.startsWith(FOUNDER_PREFIX)) return null;
  const n = parseInt(code.slice(FOUNDER_PREFIX.length), 10);
  if (Number.isNaN(n) || n < 1 || n > MAX_FOUNDERS) return null;
  return n;
}

async function fetchAllFounderPromoCodes(apiKey) {
  const all = [];
  let startingAfter = null;
  // Defensive cap — at 100 founders we still need only 1 page; loop bounded so a
  // misbehaving cursor can't spin us forever.
  for (let page = 0; page < 5; page++) {
    const url = new URL("https://api.stripe.com/v1/promotion_codes");
    url.searchParams.set("limit", "100");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);

    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Stripe-Version": STRIPE_API_VERSION,
      },
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(
        `Stripe list promo codes ${r.status}: ${j.error?.message ?? "unknown"}`
      );
    }
    const j = await r.json();
    for (const pc of j.data ?? []) {
      if (typeof pc.code === "string" && pc.code.startsWith(FOUNDER_PREFIX)) {
        all.push(pc);
      }
    }
    if (!j.has_more) break;
    startingAfter = j.data?.[j.data.length - 1]?.id ?? null;
    if (!startingAfter) break;
  }
  return all;
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
      "access-control-allow-origin": "*",
    },
  });
}

function softFallback(reason, detail) {
  // Stripe is unhappy or unconfigured. Return standard $197 so the splash
  // doesn't break. Internal "reason" is logged in CF Pages but never shown
  // to the visitor.
  if (detail) console.error(`founder-coupon soft-fallback: ${reason} — ${detail}`);
  return jsonResponse({
    founderActive: false,
    code: null,
    currentPrice: STANDARD_PRICE,
    claimedCount: 0,
    maxFounders: MAX_FOUNDERS,
    reservedUntil: null,
    // Diagnostic: surface failure reason to the splash JS console so we can
    // tell `no-runtime-key` from `stripe-error` from the front-end without
    // needing CF Pages logs. Truncated to 200 chars to be safe; key value is
    // never included in `detail`. Remove once founder pricing is verified live.
    _debug: { reason, detail: typeof detail === "string" ? detail.slice(0, 200) : null },
  });
}
