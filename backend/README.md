# DettyPot backend

The API that owns every pot, member, vote and naira. The website (and later the
WhatsApp assistant) talk only to this; nothing reaches the database or a payment
provider directly from the browser.

TypeScript, Fastify, Zod, Postgres (Kysely), Vitest.

## Run it

Requires Node 22+ and a Postgres 14+ database. The easiest way is Docker; any
local Postgres (for example Postgres.app) works too.

```sh
cd backend
npm install
cp .env.example .env     # local settings (git-ignored)
npm run db:up            # start Postgres in Docker (port 5433)
npm run db:migrate       # apply migrations to the dev database
npm run dev              # API on http://localhost:3000
```

Already have Postgres? Skip `db:up`, create two empty databases (`dettypot` and
`dettypot_test`) and set `DATABASE_URL` and `TEST_DATABASE_URL` in `.env`.

- Interactive API docs: http://localhost:3000/docs (when `ENABLE_DOCS=true`)
- Liveness: `GET /health`, readiness (checks the database): `GET /health/ready`

### The background worker

Payment reminders, deadline alerts, email delivery and closing expired votes run
in a separate process:

```sh
npm run worker          # alongside `npm run dev`
```

Locally, emails are written to the worker's log instead of being sent
(`EMAIL_PROVIDER=log`). Every job is safe to run on several workers at once.

- Reminders go to members who still owe money, at each member's chosen frequency
  (daily, every 3 days, weekly, or off), only between 09:00 and 20:00 local time.
- Two days before the deadline, members who still owe get a warning. If the
  deadline passes without the target met, the organisers are asked to decide.
- Failed emails are retried after 1, 5, 30, 120 and 360 minutes, then marked failed.

### Admin access

There is no API for granting admin rights. Someone with database access runs:

```sh
npm run admin:grant -- support@example.com      # add --revoke to remove
```

The person must have signed in once first. Admin routes answer `404` to everyone else.

### Signing in locally

The API accepts sign-in tokens from an OpenID Connect provider (Cognito or
similar). On your machine you don't need one:

```sh
npm run dev:token -- ada@example.com --name "Ada Obi"   # prints a token
```

The first run creates a local signing key in `.dev-auth/` (git-ignored); restart
`npm run dev` once so the API picks it up. Then open http://localhost:3000/docs,
click **Authorize**, paste the token, and try `GET /me`. Add `--unverified` to act
as someone whose email isn't verified yet. This only works with `APP_ENV=local`.

## Test it

```sh
npm run db:up
npm test                 # wipes and re-migrates dettypot_test, then runs every suite
npm run typecheck
npm run lint
```

The test database name must end in `_test`; the suite refuses to wipe anything else.

## Changing the schema

1. Add a new file in `migrations/`, numbered after the last one (e.g. `0010_votes.sql`).
2. `npm run db:migrate` to apply it to your dev database.
3. `npm run db:types` to regenerate `src/db/types.ts` from the real schema. Commit it.
   CI fails if the committed types do not match the migrations (`npm run db:types:check`).
4. Add tests that try to break the new rules.

## Layout

```
src/config.ts       validated environment settings
src/app.ts          builds the Fastify app (errors, request ids, docs, sign-in)
src/auth/           token verification, the pot permissions table, authorizePot()
src/users/          creating and syncing users from sign-in, profiles
src/routes/         HTTP routes, one file per area
scripts/            developer tools (dev:token)
src/db/             Kysely client, migration runner, generated table types
migrations/         forward-only .sql files, run in filename order
test/               Vitest suites (real Postgres, no mocks for the database)
```

## API

All amounts are integers in **kobo** (₦1 = 100 kobo). Full, interactive reference at `/docs`.

| Endpoint | What it does |
|---|---|
| `GET /me`, `PATCH /me` | Your profile (created on first sign-in) |
| `POST /pots` | Create a pot; you become its organiser |
| `GET /pots` | Your dashboard: each pot's stage, your share, what you've paid and still owe |
| `GET /pots/:id` | The pot page: details, members, who has paid what |
| `PATCH /pots/:id` | Edit details, until the pot is funded. Budget changes notify every member |
| `PATCH /pots/:id/settings` | Join approval and payout approval (organiser only) |
| `POST /pots/:id/stage` | Move to the next stage, once that stage's conditions are met |
| `POST /pots/:id/cancel` | Cancel (organiser only) |
| `POST /pots/:id/invites`, `GET`, `…/:inviteId/revoke` | Invite links: optional use limit and expiry; the token is shown once |
| `GET /invites/:token` | Public preview for the invite page (no sign-in): name, date, share, member count |
| `POST /invites/:token/join` | Join; waits for approval if the pot asks for it |
| `GET /pots/:id/join-requests`, `…/:userId/approve`, `…/decline` | Organisers handle people waiting to join |
| `POST /pots/:id/members/:userId/remove`, `POST /pots/:id/leave` | Remove a member, or leave |
| `POST /pots/:id/co-organisers` | Nominate a co-organiser; members vote |
| `GET /pots/:id/approvals`, `…/:requestId/votes`, `…/cancel` | See, vote on, or withdraw decisions |
| `POST /pots/:id/members/:userId/demote` | Take co-organiser rights back (no vote needed) |
| `POST /pots/:id/invites/email` | Invite someone by email, with or without an account (single use, tied to that verified address) |
| `GET /notifications`, `POST /notifications/read` | Your notifications with ready-to-show text, and marking them read |
| `GET /pots/:id/payments/options` | What you owe, the minimum, and share + fee = total for card and bank transfer |
| `POST /pots/:id/payments` | Start a payment; send the member to `checkoutUrl` |
| `GET /pots/:id/payments/mine`, `…/:paymentId` | Payment status |
| `GET /pots/:id/ledger` | Every movement of the pot's money in plain language, fee lines included |
| `GET /banks`, `POST /pots/:id/payouts/resolve-account` | Banks, and the real name on an account before paying it |
| `POST /pots/:id/payouts`, `GET /pots/:id/payouts` | Pay money out (organiser), and every payout for all members to see |
| `POST /pots/:id/payouts/:payoutId/flag`, `…/cancel` | Any member flags a payout on hold; the organiser withdraws an unsent one |
| `POST /pots/:id/settle` | Refund what's left after the outing, in proportion (organiser) |
| `GET /refunds/mine`, `POST /refunds/:refundId/account` | Your refunds; where to send one your bank can't receive automatically |
| `POST /webhooks/paystack` | Paystack's signed notifications (not for clients) |
| `GET/POST /admin/fees`, `GET /admin/payments`, `GET /admin/webhooks` | Fee schedules; payments held for review; webhooks that ran out of retries |
| `GET /admin/payouts`, `POST /admin/payouts/:id/release\|cancel\|retry` | Flagged and stuck payouts, and support's decision on them |
| `GET /admin/refunds` | Refunds that failed or are waiting on a member's account details |
| `POST /waitlist` | The website's waitlist form (no sign-in) |
| `GET /admin/pots`, `/admin/pots/:id`, `/admin/users`, `/admin/audit` | Support tools: search, a pot's full record, the audit log (admins only) |
| `POST /admin/pots/:id/freeze`, `…/unfreeze` | Pause a pot: read-only for its members until lifted |

Stage conditions: collecting needs a future funding deadline; funded needs the
target met, or, after the deadline, the organiser choosing to go ahead with what
was raised; completed needs the outing date to have arrived. Payout approval can
be switched on at any time but off only while planning. A pot holding money
can't be cancelled until automatic refunds arrive with payments.

Joining: only with a valid invite link, only while the pot is planning or
collecting, and never past the headcount. Someone the organiser removed can't
use a shared link to get back in. Members who have paid in can't leave or be
removed until refunds exist.

Co-organisers: the organiser nominates a member; a majority of the other active
members must approve within 72 hours, and the organiser's nomination counts as
their yes (so in a two-person pot it passes at once). Only people who were in
the pot when the vote opened can vote.

## Money

The rules (MON-01 to MON-18 in the BRD) and where they live:

- **A payment exists before anyone pays.** `POST /pots/:id/payments` records the
  member, pot, share, fee, total, fee schedule and a unique reference, then opens a
  Paystack checkout for exactly that total. Card, or bank transfer to a one-off
  account number Paystack shows at checkout.
- **Money counts only when Paystack confirms it.** Webhooks must carry a valid
  `x-paystack-signature` (HMAC-SHA512 of the raw body). Each one is stored first,
  then the payment is checked with Paystack's verify API, and only counted if the
  amount, currency and reference all match. A mismatch is held as `review` for a
  person; it never counts automatically.
- **Nothing counts twice.** The same webhook is stored once, the payment row is
  locked while it's confirmed, and the ledger refuses a second posting for the
  same payment.
- **Nothing is lost.** Stored webhooks are retried by the worker (1, 5, 15, 60,
  180 minutes, then flagged). Payments left pending past an hour are checked with
  Paystack once more before expiring, and money that arrives late still counts.
- **The fee.** Contributors pay share + one service fee: Paystack's cost plus
  DettyPot's margin (zero during the beta), grossed up so the pot always receives
  the full share, rounded up to the naira. Cards are quoted at the international
  rate. The fee is non-refundable for now, and each payment records that rule.
  Admins change fee schedules from `/admin/fees`; started payments keep theirs.
- **The ledger.** Each payment is one balanced posting: the share into the pot,
  and the fee as two lines (what Paystack kept, what DettyPot kept). If Paystack
  keeps more than the fee covered, DettyPot's line goes negative, never the pot.
- **Instalments and overpaying** are allowed; each payment is at least ₦1,000,
  unless it exactly clears what the member still owes.
- **Funded** happens automatically the moment confirmed money reaches the target.

### Payouts

- **Organiser only**, only once the pot is funded, only up to what's available
  after earlier and pending payouts (MON-09).
- **Reserved first.** The payout is recorded and its money moved to the pot's
  reserved account in one transaction before anything is sent, so two requests
  can't both pass (MON-10).
- **The account name comes from the bank** (MON-11): there is no field to type one.
- **Holds** (MON-14): 24 hours for a new account, or for more than ₦500,000 or
  half the pot. Every member is told the amount and account name, and anyone can
  flag it during the hold, which pauses it for support.
- **Member approval** (MON-13), when the pot switches it on: a majority of the
  people who had paid in, within 48 hours. The organiser's request counts as
  their yes if they paid in. Rejected or expired returns the money.
- **Sending** is claimed by one worker and keyed by the payout's reference, so
  Paystack can't pay it twice. A clear refusal returns the money; no answer is
  never treated as failure: the worker asks Paystack after 10 quiet minutes and
  resends safely only if Paystack never received it. If Paystack asks for an OTP,
  the payout stops for support (switch transfer OTP off for automated payouts).
- **Results** (MON-12) are confirmed with Paystack's verify call. Success settles
  the reserved money; DettyPot pays the transfer fee, never the pot. Failure
  returns it to the pot, and so does a bank reversal of a completed payout.

### Refunds

- **Cancelling** a pot that holds money refunds everyone what's left, in
  proportion to what they paid (MON-15). It waits for payouts in progress first.
- **Leaving or being removed** before any payout refunds that member's share
  (MON-16). Once the pot is funded or money has gone out, it's committed.
- **Leftover money** after the outing is refunded in proportion when the
  organiser settles up (MON-17). Splits are exact to the kobo.
- The **service fee is never refunded**: refunds go against the payments the
  money came from, never more than each payment's share, and the database
  refuses anything more.
- Money is **reserved, then settled** when Paystack confirms, or put back in the
  pot if the refund fails (support sees those at `/admin/refunds`).
- **Never twice:** each refund carries its own id in Paystack's note; if an answer
  is lost, the worker looks for that refund before asking again.
- When the bank needs the member's account (common for bank transfers), they're
  asked, the account is checked with the bank, and Paystack retries.

Coming next: rolling leftover money into a new outing (with each contributor's
consent), and a daily reconciliation against Paystack.

## Who can do what

Every pot route calls `authorizePot(db, user, potId, action)` before doing
anything. It reads one table, [`src/auth/permissions.ts`](src/auth/permissions.ts):

| Action | Organiser | Co-organiser | Member |
|---|:-:|:-:|:-:|
| View the pot, its ledger; vote on approvals | ✓ | ✓ | ✓ |
| Contribute (verified email required) | ✓ | ✓ | ✓ |
| Edit details, move the stage, manage invites, approve joins, remove members, select the venue | ✓ | ✓ | |
| Cancel the pot (refunds everyone), go ahead with less after a missed deadline, change approval settings, nominate co-organisers | ✓ | | |
| Request a payout (verified email required) | ✓ | | |

Co-organisers can only remove plain members; nobody can remove the organiser.
People who aren't active members get `404 Pot not found`, so pot ids can't be probed.

## Data rules enforced by the database

These hold even if application code has a bug:

- **Ledger** (`ledger_*`): every transaction's entries sum to zero; rows can never be
  updated, deleted or truncated; entries can't be added to a committed transaction;
  pot accounts can never go below zero, even with concurrent writes; each event can
  only be posted once (idempotency key).
- **Audit log** and **approval votes**: append-only.
- **Pots**: start in `planning` and move only along
  planning → collecting → funded → confirmed → completed (or → cancelled before
  completion); budget and headcount lock once funded; never deleted.
- **Members**: exactly one organiser per pot; co-organisers and organisers must be
  active; members are never deleted (who paid stays visible).
- **Users**: deletion anonymises the row (no personal data left) instead of removing it.

## Environments

`local`, `test`, `dev`, `staging`, `prod`, set with `APP_ENV`. See
[docs/environments.md](../docs/environments.md) for how code ships through them.

## Conventions

- Errors always return `{ "error": { "code", "message", "requestId" } }`.
- Every response carries an `x-request-id` header; quote it when reporting a problem.
- Money is stored as integer kobo, never floats.
- Migrations are forward-only. Fix a mistake with a new migration, never by editing one that has run.
- Secrets live in environment variables (a secrets manager in AWS), never in the repo.
