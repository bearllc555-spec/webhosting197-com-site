# webhosting197-com-site

Source for the **webhosting197.com** Cloudflare Pages project.

## Positioning

**Lifetime cloud web hosting. $197. With AI.** One payment, one website, forever-on edge hosting + AI to build/maintain/update. Launching 2026.

## Brand

Standalone product identity, distinct from the `slatepress.{co,net,org,press}` namespace. Emerald palette is reserved for the brand mark; the new Mercury-clean splash uses a blue (`#2563EB`) accent for buttons. "Another SlatePress company" footer trust-transfer per the SlatePress brand-architecture rule.

## Live

- **Apex:** https://webhosting197.com/
- **www:** https://www.webhosting197.com/
- **Pages preview:** https://webhosting197-com.pages.dev/

## Layout

```
.
├── index.html              <- splash (Mercury-clean, blue CTAs, count-down 999->197)
├── functions/
│   └── api/
│       └── verify/
│           ├── start.js    <- email verification kickoff (TBD)
│           └── check.js    <- email verification confirmation (TBD)
└── .github/workflows/
    └── deploy.yml          <- auto-deploy via cloudflare/wrangler-action@v3
```

## Deploy

Auto-deploy via GitHub Actions on every push to `main`. Same pattern as `bearllc555-spec/plumbingslatepress-com-site`. Replaces the previous Direct-Upload + zip-drag pattern.

Required repo secrets:
- `CLOUDFLARE_API_TOKEN` — token name: `webhosting197-com-site-github-actions`, scope: `Account -> Cloudflare Pages -> Edit`
- `CLOUDFLARE_ACCOUNT_ID` — `e0f6f68f26f8a26a75eaa793385019ef`

**Commit-message constraint:** plain ASCII only on this repo. Em-dashes and curly quotes break the Cloudflare Pages deployments API (error code 8000111). Locked in `slatepress\CLAUDE.md` operational rules.

— Another SlatePress company.
