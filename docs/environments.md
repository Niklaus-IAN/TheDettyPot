# Environments and shipping

DettyPot runs in three deployed environments, plus developers' machines. Code
moves through them in one direction, and the same build is promoted from one to
the next, so what was tested in staging is exactly what reaches production.

## The environments

| | local | dev | staging | prod |
|---|---|---|---|---|
| Purpose | Building and running tests | Shared integration; see every merge working | Final checks before release | Real users, real money |
| `APP_ENV` | `local` | `dev` | `staging` | `prod` |
| Deployed when | You run it | Every merge to `main` | A dev build is promoted | A staging build is approved |
| Database | Your own Postgres | Its own RDS instance | Its own RDS instance | Its own RDS instance, point-in-time recovery |
| Data | Throwaway | Throwaway, seed data | Synthetic, production-like | Real |
| Paystack | Test keys | Test keys | Test keys | **Live keys, prod only** |
| API docs (`/docs`) | On | On | On | **Off (the app refuses to start with them on)** |
| Who can access | You | Team | Team, invited testers | Everyone |

Each environment runs two processes from the same build: the **API** and the
**worker** (reminders, deadline alerts, email delivery). In AWS both run as
separate services; the worker can be scaled to more than one copy safely.
Emails are only really sent where `EMAIL_PROVIDER` points at Amazon SES; locally
they are written to the log. Behind the load balancer, `TRUST_PROXY=true` so
rate limits apply per caller.

Each deployed environment has its own AWS resources, its own secrets in AWS
Secrets Manager and its own database. Nothing is shared between them, and
production data is never copied into dev or staging (Nigeria Data Protection
Act).

## How a change ships

```
feature branch ──PR──▶ main ──auto──▶ dev ──promote──▶ staging ──approve──▶ prod
                 CI must pass
```

1. **Branch.** Work happens on a short-lived branch off `main`.
2. **Pull request.** CI runs typecheck, lint, the full test suite against a real
   Postgres, the generated-types check and the build. A PR cannot merge unless
   CI is green.
3. **Merge to `main` → dev.** Every merge builds one container image, tagged
   with the commit, and deploys it to dev automatically.
4. **Promote → staging.** When dev looks right, the *same image* is deployed to
   staging. Nothing is rebuilt.
5. **Approve → prod.** After checks in staging, a person approves the release
   and the same image goes to production.

Hotfixes follow the same path, just faster. There is no way to deploy to prod
that skips staging.

## Database migrations across environments

- Migrations run automatically as a step of each deploy, before the new code
  starts serving traffic.
- During a deploy the old version keeps running for a moment against the new
  schema, so every migration must be backward compatible: add first, switch the
  code over, and only remove the old column or table in a later release
  ("expand, then contract").
- Migrations are forward-only. A mistake is fixed with a new migration, never by
  editing one that has already run anywhere.
- In deployed environments the app connects with a database role that cannot
  alter tables or disable triggers, so the ledger and audit log stay
  append-only even if the app itself is compromised. Migrations run with a
  separate, more privileged role.

## Still to set up

These come with the AWS infrastructure step and need repository-admin access:

- [ ] Branch protection on `main`: pull request required, CI must pass.
- [ ] AWS accounts or isolated stacks for dev, staging and prod (region decision pending).
- [ ] Deploy pipeline: build once, promote by image, manual approval for prod.
- [ ] Secrets in AWS Secrets Manager per environment; rotate any keys carried
      over from the previous version of the app.
- [ ] Separate database roles for migrations and for the running app.
- [ ] Amazon SES: verified sending domain, `EMAIL_PROVIDER=ses`, bounce handling.
- [ ] Paystack: test secret key in dev and staging, live key in prod only (the
      app refuses any other combination). Webhook URL per environment set in the
      Paystack dashboard: `https://<api-host>/webhooks/paystack`.
- [ ] Worker service running `npm run start:worker` next to the API.
