# functions-deprecated/

Cloudflare Pages Functions that were deployed at some point but are no longer
called by any live page. Preserved here in source form so the next person can
revive them without spelunking through git history.

**Why a separate folder rather than `git rm`?**
Cloudflare Pages auto-deploys anything under `functions/` as live serverless
endpoints. Moving to `functions-deprecated/` removes them from the deploy
without losing the implementation. To revive: `git mv functions-deprecated/api/X functions/api/X`.

---

## `api/verify/start.js` + `api/verify/check.js`

SendGrid-direct OTP email verification with HMAC-signed cookie. Powered the
splash launch-list capture (email -> OTP -> verify -> add to SendGrid Marketing
List "Webhosting197 Launch List").

**Retired:** 2026-05-08 (splash v10) when the waitlist flow was lightened to a
single-shot Formspree POST (`xykonjqq` form, `source=webhosting197-waitlist`).
Operator now gets the lead directly via Formspree; no OTP, no marketing-list
side-effects.

**Last live caller:** `index.html` v09 (splash) — replaced in v10.
**Still referenced by:** `old/index.html` (the 2026-05-07 archival snapshot).
The form on `/old/` will silently fail if anyone hits it; that page is meant
to be a frozen reference for A/B comparison and rollback only.

**Env vars** (no longer required on the Cloudflare Pages project, but harmless
to leave set):
- `SENDGRID_API_KEY`
- `SENDGRID_TEMPLATE_ID` (= `d-d992eab67cce4e07811c36f6eefcf0d0`)
- `SENDGRID_FROM_EMAIL` (= `hello@webhosting197.com`)
- `SENDGRID_FROM_NAME` (= `Webhosting197`)
- `SENDGRID_MARKETING_LIST_ID` (= `085a8f42-e0ab-4967-9927-412014e88775`)
- `OPERATOR_NOTIFY_EMAIL` (= `bearllc555@gmail.com`)
- `VERIFY_SIGNING_SECRET`

The SendGrid Marketing List itself, the dynamic template, and the API key are
all still provisioned. Reviving the endpoints is `git mv` + redeploy.

**When to revive:** if we ever want server-side email verification anywhere
else (say, a higher-friction lead form that needs to prove deliverability),
this is the working blueprint.
