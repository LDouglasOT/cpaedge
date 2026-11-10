# QuizBot

WhatsApp quiz platform: an Express API + React admin dashboard, with students practising through
WhatsApp using [`@sasa-dev/void-baileys`](https://www.npmjs.com/package/@sasa-dev/void-baileys).

```
server/   Express API, SQLite (node:sqlite), WhatsApp session manager and the chat bot
client/   React (Vite) dashboard: Dashboard, WhatsApp, Funds, Question bank
```

## Run it

Needs Node 22.5+ (the API uses the built-in `node:sqlite`, so there is no database to install).

```bash
npm run install:all
# fill in server/.env (see Payments below)
npm run start                           # builds the dashboard, serves everything on http://localhost:4000
```

Development with hot reload: `npm run dev:server` in one terminal and `npm run dev:client` in another (dashboard on :5173).
`npm run smoke` drives the whole bot conversation with a fake socket and checks the flow.

Sign in with `ADMIN_PASSWORD` (default `admin123`, change it).

## How it works

**WhatsApp tab** - add as many accounts as you like. Each shows a QR (or a pairing code if you enter the phone number).
Credentials are saved under `server/data/sessions/<id>` and every session is restored on restart.
*Terminate session* logs the account out of WhatsApp and deletes its saved credentials.

**Student chat** (every connected account listens for messages)

1. `hi` (or any greeting) -> greeting, welcome message, list of courses
2. pick a course -> list of sub topics
3. pick a sub topic -> question (with its attached document, if any) and up to 3 answer buttons
4. tap an answer -> correct / wrong, with buttons **Explain**, **Next question**, **Re-attempt**
   - *Re-attempt* shows the same question again, *Next question* skips ahead, *Explain* shows the correct answer and your explanation
5. after the free trial questions (default 5) the bot sends one **Mobile Money Pay** button for the price set in Funds > settings
6. `rank` -> attempted, correct, accuracy, position among all students, top 3

Trial rule: a trial is used the first time a student answers a given question. Re-attempts don't use extra trials,
but once the trial is used up every question (including re-attempts) is locked behind payment.
Ranking orders students by number of distinct questions answered correctly, then accuracy.

**Funds tab** - all transactions, balance, withdrawals, and settings (premium price, currency, free trial count, welcome message).
A withdrawal is recorded as *pending* and reserved from the balance; use *Mark paid out* after you've sent the money.

## Payments (MarzPay)

Fill in `server/.env` (created for you, copied from `.env.example`):

| Variable | Where to get it |
| --- | --- |
| `MARZPAY_API_KEY`, `MARZPAY_API_SECRET` | MarzPay dashboard > API keys |
| `MARZPAY_WEBHOOK_SECRET` | MarzPay webhook settings: enable signing and copy the signing secret |
| `PUBLIC_URL` | The public https address of this server, e.g. `https://quiz.example.com` |
| `ADMIN_PASSWORD`, `AUTH_SECRET` | Your choice (dashboard login, and a long random string) |

How it works: when a student taps **Mobile Money Pay** and gives a number, the API calls MarzPay's `collect-money`
(UGX, country `UG`, a UUID reference, callback `PUBLIC_URL/api/payments/webhook/marzpay`). MarzPay prompts the student's phone;
when they approve, MarzPay posts a signed `collection.completed` event, the student becomes Premium and gets a WhatsApp message.
A `collection.failed` event marks the payment failed and offers the student a retry button.

- Webhooks are only accepted with a valid signature (and a timestamp within 10 minutes). If `MARZPAY_WEBHOOK_SECRET` is empty they are refused.
- A completed event for less than the expected amount is left pending and logged for manual review.
- MarzPay accepts whole amounts from 500 to 10,000,000 UGX, and the premium price setting enforces that.
- MarzPay's docs don't show a transaction-status endpoint, so confirmation relies on the webhook. If a webhook never arrives, use **Mark paid** on the pending transaction in the Funds tab.
- Withdrawals are bookkeeping only; they reserve the balance and you mark them paid out after sending the money.
- For local testing without MarzPay, set `PAYMENT_PROVIDER=mock` (auto-confirms after a few seconds).

## Notes

- WhatsApp automation through unofficial libraries can get numbers banned. Use dedicated numbers, not your main one.
- Uploaded question documents are served from `/uploads/<random-name>` without login (names are unguessable).
- Dates in the dashboard charts are grouped in UTC.
