# DettyPot

Plan together. Fund together. Live together.

DettyPot lets a group of friends plan an outing, pool the money for it, and go.
One person creates a pot and invites friends, the group picks a real venue and
date, everyone chips in, and the organiser pays the venue from the pot. Every
member can see where their money went.

## Repository

| Path | What it is |
|---|---|
| [`backend/`](backend/) | The API: TypeScript, Fastify, Postgres. Owns every pot, member and naira. |
| [`docs/`](docs/) | How the project is run, starting with [environments and shipping](docs/environments.md). |

The website and the WhatsApp assistant will talk only to the backend API;
nothing reaches the database or a payment provider directly from a browser.

## Status

Early build. Done so far:

- Backend foundations: configuration, error handling, request tracing, API docs, CI.
- Database schema for users, pots and their stages, members and roles, invites,
  co-organiser approvals, notifications, an append-only audit log, and a
  double-entry ledger that refuses to let a pot's balance go negative.
- Sign-in with any OpenID Connect provider, accounts created on first sign-in,
  profiles, and a single permissions table for what each role can do in a pot.

- Pots API: create, edit, dashboard, pot page with who has paid, settings, and
  the stage lifecycle (planning → collecting → funded → confirmed → completed).

- Invites and membership: invite links with a public preview, joining with
  optional approval, leaving and removal, and co-organisers chosen by member vote.

- Notifications: in-app and email for every event, payment reminders at each
  member's chosen frequency, deadline alerts, email invites, retries.
- Support tools: search, a pot's full record and audit trail, freezing a pot.
- A working waitlist, and rate limits on public and sensitive endpoints.

- Payments (Paystack): checkout quotes, card and bank transfer, signed and
  de-duplicated webhooks, a balanced ledger every member can read, automatic
  "funded", and expiry of abandoned payments.

- Payouts: reserved before sending, account names from the bank, holds and
  flags, optional contributor approval, and every transfer result handled.

- Refunds: on cancellation, leaving or removal, and leftover settle-up, in
  proportion and never including the fee, with a path for when the bank needs
  the member's account.

- Daily reconciliation with Paystack that fixes lost webhooks and flags
  anything else for support.

- Rolling leftover money into a new outing, with each contributor's consent.

Next: real venues and the AI planner, then deployment to AWS.

## Getting started

See [backend/README.md](backend/README.md).
