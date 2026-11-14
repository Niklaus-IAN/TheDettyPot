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

With the Anthropic and Google keys set, the worker also answers planner questions,
on its own two-second loop.

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
src/planner/        the AI planner: Claude client, cost logging, the tool loop
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
| `GET /me/export`, `POST /me/delete` | Download everything held about you; delete your account (personal details removed, money records kept anonymously) |
| `POST /pots` | Create a pot; you become its organiser |
| `GET /pots` | Your dashboard: each pot's stage, your share, what you've paid and still owe |
| `GET /pots/:id` | The pot page: details, members, who has paid what |
| `PATCH /pots/:id` | Edit details, until the pot is funded. Budget changes notify every member |
| `PATCH /pots/:id/settings` | Join approval and payout approval (organiser only) |
| `PATCH /pots/:id/me` | Your own setting in a pot: how often you're reminded to pay |
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
| `GET /pots/:id/places/search?q=` | Search real places (Google Maps) near the pot's area |
| `GET/POST /pots/:id/venues`, `…/:venueId/vote\|unvote\|remove\|select` | The venue shortlist with live details; voting; the organiser's pick |
| `PATCH /pots/:id/venue-voting` | Set or clear the venue voting deadline |
| `GET/POST /pots/:id/dates`, `PUT …/:optionId/answer` | The date poll |
| `GET /places/photo?name=` | A venue photo, via Google, without exposing the API key |
| `GET /pots/:id/places/:placeId` | One place's live details from Google |
| `GET /pots/:id/planner` | The pot's conversation with the AI planner, its suggestions, and today's remaining questions |
| `POST /pots/:id/planner/messages`, `…/regenerate` | Ask the planner (answered in the background: poll while `busy`); answer the latest question again |
| `GET /pots/:id/planner/replies/:replyId/places` | Live Google details for one answer's suggestions: load once when the answer is shown |
| `POST /pots/:id/planner/suggestions/:suggestionId/add` | Put a planner suggestion to the vote |
| `GET /admin/ai-usage?days=` | What the planner has cost, by model and purpose, and the costliest pots |
| `GET /pots/:id/payments/options` | What you owe, the minimum, and share + fee = total for card and bank transfer |
| `POST /pots/:id/payments` | Start a payment; send the member to `checkoutUrl` |
| `GET /pots/:id/payments/mine`, `…/:paymentId` | Payment status |
| `GET /pots/:id/ledger` | Every movement of the pot's money in plain language, fee lines included |
| `GET /banks`, `POST /pots/:id/payouts/resolve-account` | Banks, and the real name on an account before paying it |
| `POST /pots/:id/payouts`, `GET /pots/:id/payouts` | Pay money out (organiser), and every payout for all members to see |
| `POST /pots/:id/payouts/:payoutId/flag`, `…/cancel` | Any member flags a payout on hold; the organiser withdraws an unsent one |
| `POST /pots/:id/settle` | Settle what's left after the outing (organiser): refund it in proportion, or offer to roll it into a new pot |
| `GET /rollovers/:id`, `POST /rollovers/:id/choice`, `GET /pots/:id/rollovers` | A contributor's part of a roll-over and their choice; the organiser's view |
| `GET /refunds/mine`, `POST /refunds/:refundId/account` | Your refunds; where to send one your bank can't receive automatically |
| `POST /webhooks/paystack` | Paystack's signed notifications (not for clients) |
| `GET/POST /admin/fees`, `GET /admin/payments`, `GET /admin/webhooks` | Fee schedules; payments held for review; webhooks that ran out of retries |
| `GET /admin/payouts`, `POST /admin/payouts/:id/release\|cancel\|retry` | Flagged and stuck payouts, and support's decision on them |
| `GET /admin/refunds` | Refunds that failed or are waiting on a member's account details |
| `GET /admin/reconciliation`, `POST …/run`, `POST …/findings/:id/resolve` | Daily checks against Paystack and what they found |
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

## Venues

Google's terms shape how venues work: only Google's **place ID** is stored. A
venue's name, address, rating, hours and photos are fetched fresh from Google
whenever they're shown, and notifications carry our venue ID, never the name.
Custom venues (someone's house) keep what members typed. Photos go through
`/places/photo`, which swaps Google's keyed URL for a key-free one, and every
place in a response carries `attribution: "Google Maps"`, which screens must show
along with each photo's author credit. Costs are labelled: the organiser's own
figure, or an estimate (AI-03). The chosen venue locks once the pot is confirmed,
in the API and in the database.

## AI planner

A conversation inside each pot (AI-05): a member asks ("beach spot in Lekki under
₦20k a head"), and the worker answers within seconds while the website polls.
How an answer is made:

- Claude (`PLANNER_MODEL`, Opus by default) is told only the pot's own settings:
  vibe, budget per person, group size, date and area (AI-01). Never member names
  or anything about payments, and long numbers such as card or account numbers
  are removed from what members type before it's stored or sent (AI-11).
- It finds places with a `search_places` tool backed by Google, then answers
  through a `share_suggestions` tool. **Any place it suggests that didn't come
  back from a search in that answer is sent back to it, then dropped**, so
  nothing comes from the model's memory.
- Each suggestion has why it fits, a cost per person that is always labelled an
  estimate (AI-03), and an optional safety note labelled "AI guidance", with any
  score or percentage refused (AI-04). Only the place ID is kept (AI-10).
- Polling the conversation never calls Google, since every place lookup is
  billed. The screen loads an answer's place details once, when it shows the
  answer, from `GET /pots/:id/planner/replies/:replyId/places`.
- Answering again replaces the old answer and its suggestions (AI-07). A member
  can put any suggestion to the vote; it joins the shortlist as a planner pick.
- Long conversations: older messages are folded into a short summary by the
  smaller model (`PLANNER_LIGHT_MODEL`, Haiku by default) (AI-09).
- Limits (AI-06): one question at a time per pot; `PLANNER_POT_DAILY_LIMIT` and
  `PLANNER_USER_DAILY_LIMIT` questions in any 24 hours; at most 4 Google searches
  and 6 round trips with Claude per answer.
- Every call to Claude is logged in `ai_calls` with its prompt version, model,
  tokens and cost (AI-11). If Claude declines, a fallback model can step in; its
  share is priced at its own rate. Deleting an account clears that person's
  words from the chat and from the logs; the numbers stay.

Without `ANTHROPIC_API_KEY` and `GOOGLE_MAPS_API_KEY`, the planner answers 503.

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

### Reconciliation

Once a day (after 02:00 Lagos time) the worker compares the last 48 hours of
Paystack's charges and transfers with DettyPot's records. It fixes what it
safely can (a payment whose webhook never came, a transfer result we missed) and
records the rest as findings, emailing admins: money at Paystack we have no
record of, a payment we count that Paystack doesn't, amounts that differ, and
ledger totals that don't match the payments, payouts and refunds behind them.
Admins review and resolve findings at `/admin/reconciliation`.

### Rolling leftover money into a new outing

Instead of refunding, the organiser can offer to move what's left into a new pot
they organise that is still planning or collecting. Each contributor's part (in
proportion to what they paid) is set aside at once, and each person chooses:
**move** it (they join the new pot and it counts as paid there) or **refund** it.
Anyone who hasn't chosen within 72 hours is refunded. Money that moved can still
be refunded later from the new pot, against the payment it originally came from.

## Who can do what

Every pot route calls `authorizePot(db, user, potId, action)` before doing
anything. It reads one table, [`src/auth/permissions.ts`](src/auth/permissions.ts):

| Action | Organiser | Co-organiser | Member |
|---|:-:|:-:|:-:|
| View the pot, its ledger; vote on approvals | ✓ | ✓ | ✓ |
| Contribute (verified email required) | ✓ | ✓ | ✓ |
| Add venues, vote on venues and dates, ask the AI planner | ✓ | ✓ | ✓ |
| Edit details, move the stage, manage invites, approve joins, remove members, run the date poll | ✓ | ✓ | |
| Choose the venue (FR-PLN-05), cancel the pot (refunds everyone), go ahead with less after a missed deadline, change approval settings, nominate co-organisers | ✓ | | |
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

### Running in AWS

One image ([Dockerfile](Dockerfile)) runs the API (`node dist/index.js`, the
default), the worker (`node dist/worker.js`) and migrations
(`node dist/db/migrate.js`). It's built in CI; you don't need Docker locally.
[infra/](../infra/) describes the AWS side.

Settings that only matter there:

| Setting | What it does |
|---|---|
| `APP_SECRET_ID` | A Secrets Manager secret of JSON keys (`PAYSTACK_SECRET_KEY`, `GOOGLE_MAPS_API_KEY`, `ANTHROPIC_API_KEY`), read at startup. A key already in the environment wins. |
| `DATABASE_SECRET_ID` | The RDS secret; becomes `DATABASE_URL` with TLS verified (`sslmode=verify-full`, against the RDS certificates in the image). |
| `TRUST_PROXY_HOPS` | How many proxies sit in front (API Gateway: 1). Only their addresses are trusted, so callers can't fake theirs. |

Sign-in tokens are Cognito **ID tokens**: the API checks the issuer, that the
audience is the web client, and reads the email and whether it's confirmed.

## Conventions

- Errors always return `{ "error": { "code", "message", "requestId" } }`.
- Every response carries an `x-request-id` header; quote it when reporting a problem.
- Money is stored as integer kobo, never floats.
- Migrations are forward-only. Fix a mistake with a new migration, never by editing one that has run.
- Secrets live in environment variables (a secrets manager in AWS), never in the repo.
