# ZedPrep

AI exam-preparation tutor for Zambian Grade 7, 9 and 12 learners: exam-style practice questions by subject and topic, instant marking with explanations, an AI tutor that answers in English, Nyanja, Bemba, Tonga or Lozi, progress tracking, and Premium plans paid by mobile money through Lenco.

## Stack
- Node.js 22, zero npm dependencies (built-in `http`, `crypto`, `node:sqlite`)
- SQLite database stored on a Railway volume (`DATA_DIR=/data`)
- Vanilla JS single-page app in `public/` (no build step; about 15 KB gzipped)
- AI: Anthropic (`ANTHROPIC_API_KEY`) or OpenAI (`OPENAI_API_KEY`); demo mode if neither is set
- Payments: Lenco mobile money collections (Airtel, MTN, Zamtel)

## Run locally
```
cp .env.example .env   # optional
DATA_DIR=./data ADMIN_PHONE=0971234567 npm start
# open http://localhost:3000
```

## Configuration
See `.env.example`. Key variables:

| Variable | Purpose |
|---|---|
| `ADMIN_PHONE` | The account registered (or logging in) with this number becomes admin |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Switches on real AI questions and tutoring |
| `LENCO_API_KEY` | Switches on mobile money payments |
| `LENCO_BASE_URL` | Lenco API base; use the sandbox URL for testing |
| `PRICE_*`, `FREE_*`, `PAID_*` | Prices (Kwacha) and daily limits |

Lenco webhook URL: `https://<your-domain>/api/webhooks/lenco`. The app never trusts the webhook body: it re-checks each payment with Lenco before activating a plan. Payments are also confirmed by polling while the learner waits.

## How it keeps AI costs low
- Generated questions are saved and reused across learners; new ones are only written when a learner has seen all saved questions for a topic.
- Daily limits for free and paid learners.
- Learners can report bad questions; three reports hide a question automatically, and admins review them on the admin page.

## Admin
Log in with the `ADMIN_PHONE` account and open Account → Admin dashboard: learners, revenue, AI usage, reported questions, and manual plan grants (e.g. for cash payments).

## Notes
- SQLite on a volume means run a single instance (do not scale replicas). Railway volume backups are recommended.
- Have a teacher review a sample of AI-generated questions per subject before charging learners.
