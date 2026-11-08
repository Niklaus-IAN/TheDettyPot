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
src/app.ts          builds the Fastify app (errors, request ids, docs)
src/routes/         HTTP routes, one file per area
src/db/             Kysely client, migration runner, generated table types
migrations/         forward-only .sql files, run in filename order
test/               Vitest suites (real Postgres, no mocks for the database)
```

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
