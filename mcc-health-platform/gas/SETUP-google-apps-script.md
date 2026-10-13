# MCC Health Data Platform: setup guide

This is a web app built on Google Apps Script. A Google Sheet is its database and a Drive folder stores uploaded files. Users request an account, an admin approves them, and they sign in. Approved users can then do the following:
- enter data into the Maternal Continuum-of-Care tracker forms: registration, ANC 1, ANC follow-up, delivery, PNC, pregnancy loss, referral and exit
- upload Excel, CSV, Word and PDF files

## What's in the package

| File | Purpose |
|---|---|
| `Code.gs` | Server: sign-up/approval/sign-in, sessions, roles, data entry, uploads, admin, audit |
| `Metadata.gs` | Form definitions generated from the tracker design: stages, sections, fields, option sets |
| `Index.html` | Page layout |
| `Styles.html` | Styling |
| `App.html` | Browser logic, including the form rules (GA/EDD, BMI, anaemia grade, risk flags, IPTp, skip logic) |
| `appsscript.json` | Manifest (time zone Africa/Lusaka, web app settings, permissions) |

## Deploy (about 15 minutes)

1. Create a new Google Sheet in the Google account that will own the data, for example "MCC Health Data Platform – Database".
2. In the Sheet, go to **Extensions → Apps Script**.
3. In the editor:
   - Replace the contents of `Code.gs` with the provided `Code.gs`.
   - Add a script file named `Metadata` (**+ → Script**) and paste `Metadata.gs`.
   - Add HTML files named exactly `Index`, `Styles` and `App` (**+ → HTML**) and paste each file's contents.
   - Under **Project Settings**, tick "Show appsscript.json manifest file in editor", then replace `appsscript.json` with the provided one.
4. Choose the function **`setup`** in the toolbar and click **Run**. Accept the permission prompts (Sheets, Drive, send email). This creates these tabs in your Sheet:
   - `Users`, `OrgUnits`, `Persons`, `Enrollments`, `Uploads`, `Audit`
   - one tab per stage: `EV_ANC1`, `EV_ANCFU`, `EV_DEL`, `EV_PNC`, `EV_LOSS`, `EV_REF`, `EV_EXIT`

   It also creates the Drive uploads folder. The log shows the links and the admin email.
5. **Deploy → New deployment → Web app**, then set:
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**. Use "Anyone with Google account" if you want an extra Google sign-in first.

   Click Deploy and copy the web app URL. This is the address you share.
6. Open the URL and choose **Request an account**. Use the **same email as the Google account that ran setup**. That account becomes the administrator automatically.
7. Replace the placeholder facility. Do this either in the app (**Administration → Org units**) or directly in the `OrgUnits` tab: put the real province, district and facility codes there. Codes must be unique, and the facility code becomes the UMID prefix.

## Day-to-day use

- **New users** request an account. The admin approves or rejects it under **Administration → Users** and assigns the role and facility. The user gets an email when this happens.
- **Roles:**
  - *Clinician / Data associate:* register, enter and upload data for their facility and the units below it.
  - *District viewer:* read-only, with personal data.
  - *Partner:* sees uploads and tables with personal-data columns removed. Cannot open client records.
  - *Admin:* everything, including `Users` and `Audit`.
- **Capture:** search for the woman, register her if she is new (there is a duplicate check), enroll the pregnancy with the date of LMP, then add stage events. Calculated fields fill themselves in. Warnings and the high-risk banner follow the design's program rules.
- **Upload:**
  - Excel/CSV: the rows are copied into a new `UPL_xxxx` tab and the original file goes to Drive.
  - To load rows as tracker events, download the stage's **CSV template**. It needs the columns `umid`, `event_date` and the field codes. Choose "Import as … events" when uploading.
  - Word/PDF: the file goes to Drive and its text is saved in the `Uploads` tab so it can be searched.
- **Admin access to all data:** open the Google Sheet. Every tab is the live database. The Data browser in the app also downloads CSVs.

## Security notes

- Passwords are stored only as salted, iterated SHA-256 hashes. Sessions last 6 hours. Sign-in locks for 15 minutes after 5 failed attempts.
- Every sign-in, search, read, create, update, upload and admin change is written to the `Audit` tab.
- Share the Google Sheet and Drive folder **only with admins**. Users reach data through the app, not the Sheet.
- All cells are stored as plain text, which keeps phone zeros and codes intact. Values that look like formulas are neutralised.
- Under Zambia's Data Protection Act No. 3 of 2021 this is health data, which is sensitive personal data. Keep the owning Google account protected with 2-step verification, and agree retention and access rules with MoH/the facility before live use.

## Limits and when to move on

Google Sheets works well for a pilot of a few facilities and tens of thousands of events. Each request reads whole tabs, so the app slows down as data grows. Apps Script also has daily quotas, for example on emails sent and on total runtime. For district or national scale, move to DHIS2 Tracker using the design's metadata, or to the standalone PostgreSQL design (the "Standalone build" tab of the design dashboard). The field codes are the same in both, so the Sheet data maps across directly.

## Changing forms

`Metadata.gs` is generated from the design's data dictionary. To add a field, add it to `MCC_META.fields` and to the right stage section, then run `setup` again. setup only appends new columns and never deletes data. The browser rules live in `recompute()` in `App.html`.
