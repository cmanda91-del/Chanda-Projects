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
- **Client list.** `clients.csv` is the lookup media file. Visit forms use it to find a client by facility + age + date of first ANC, QR/Unique ID or name, and to fill in her Unique ID, facility, EDD and risk flags (`pulldata` and `select_one_from_file`).
- **Pull from KoBo.** Admins can also save a KoBo API token and form asset UIDs, then press *Pull now* (`/api/koboPull`). Everything received is listed under *Data received from KoBo / ODK*.
- **KoBo REST Service.** Point it at `POST /odk/submit/<key>`. The admin sees the URL on the KoBo / ODK page. Submissions are de-duplicated by instance ID and logged in the `Submissions` table.
- **ODK Central or KoBo exports.** Import CSV/XLSX through Data upload. Group prefixes are removed automatically.
- **Apps Script version.** `doPost` accepts the same JSON at `<web app URL>?key=<key>`.

## Client identification

- **Fields not collected.** NRC, HIV status/testing, ART and viral-load fields are not collected anywhere.
- **Registration form.** Kept to essentials: date of first ANC, date of birth or age (each fills the other), ANC register number, names, phone, village, zone, CBV affiliated, next of kin, obstetric and medical history, and consent.
- **How a client is identified.** By **facility + age at first ANC + date of first ANC**, with name or phone as a tie-breaker. Capture can search by date of 1st ANC + age.
- **Unique ID.** `<District initials><Facility initials><ANC number, 4 digits>`, e.g. `LuSi0001` (Sikatengwa, Lumezi) or `MoKa0001` (Kama, Mongu).
  - Initials are the first two letters. A third (or fourth) letter is used only when another facility in the same district already has those initials, e.g. Kapongolo `Ka`, Kazembe `Kaz`, Kazonde `Kazo`.
  - The ANC number comes from the facility ANC register. If it is left blank, the next free number at that facility is used.
  - The ID is generated once, at registration, and never changes afterwards.
- **Duplicates.** Registration warns when the ID or the facility + first ANC date + age + surname already exist. You can open the existing client, or save anyway: the new ID gets a suffix (`LuSi0001B`) and is flagged for the administrator, who reviews possible duplicates under Administration.
- **Older records.** Clients registered before this change keep their earlier IDs.

## Facilities

On start-up the server adds the 7 OHNEZ facilities in Lumezi and the 12 IMNCHN facilities in Mongu (`MCC_META.facilities` in `gas/Metadata.gs`). Codes are `LUM-…` and `MON-…`. The old placeholder facility `LUM-FAC01` is removed automatically when nothing uses it.
