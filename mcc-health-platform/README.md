# MCC Health Data Platform

The Maternal Continuum-of-Care data platform. It covers:
- sign-up, admin approval and sign-in
- tracker data entry: registration, ANC 1, ANC follow-up, delivery, PNC, pregnancy loss, referral and exit
- Excel, CSV, Word and PDF uploads
- an admin console with a full database export to Excel

## Hosting on Railway (this folder)

- **Server:** `server.ts` (Bun) runs the same server logic as the Google Apps Script version (`gas/Code.gs`). Its data goes to SQLite on a Railway volume mounted at `/data`.
- **Page:** `build-page.ts` builds `public/index.html` from `gas/*.html` when the app starts.
- **Variables:**
  - `ADMIN_EMAIL`: the account that signs up with this email becomes the administrator.
  - `PUBLIC_URL`: optional.
- **Run locally:** `bun install && bun build-page.ts && ADMIN_EMAIL=you@example.org bun server.ts`

## Google Apps Script + Google Sheets version

Everything in `gas/` deploys as an Apps Script web app with a Google Sheet as the database. See `gas/SETUP-google-apps-script.md`.
