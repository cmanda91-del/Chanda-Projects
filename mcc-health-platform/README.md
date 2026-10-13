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

## KoBoToolbox / ODK

- **Forms.** In the app, **KoBo / ODK** downloads an XLSForm for registration and for each stage. Field names are the platform's data element codes. Every form converts with pyxform.
- **Client list.** `clients.csv` is the lookup media file. Visit forms use it to find a client by NRC, QR/UMID or name and to fill in her UMID, facility, EDD and HIV status (`pulldata` and `select_one_from_file`).
- **KoBo REST Service.** Point it at `POST /odk/submit/<key>`. The admin sees the URL on the KoBo / ODK page. Submissions are de-duplicated by instance ID and logged in the `Submissions` table.
- **ODK Central or KoBo exports.** Import CSV/XLSX through Data upload. Group prefixes are removed automatically.
- **Apps Script version.** `doPost` accepts the same JSON at `<web app URL>?key=<key>`.
