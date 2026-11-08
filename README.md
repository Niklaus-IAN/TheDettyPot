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

Next: pots and invites, then payments.

## Getting started

See [backend/README.md](backend/README.md).
