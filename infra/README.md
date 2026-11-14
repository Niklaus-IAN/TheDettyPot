# DettyPot infrastructure

AWS, written as code with the CDK (TypeScript). Region: **eu-west-1** (Ireland).

| Stack | What's in it |
|---|---|
| `DettyPot-shared` | The backend image repository (ECR) and the role GitHub Actions deploys with |
| `DettyPot-dev` | One environment: network, database, sign-in, the API and worker, and its public address |

## What an environment is made of

- **API and worker**: the backend image on ECS Fargate, one small Graviton container each (0.25 vCPU, 0.5 GB). Every container start applies any new migrations first, in a separate `migrate` container; the app starts only if that succeeds.
- **Database**: Postgres 16 on RDS (`db.t4g.micro`, 20 GB, encrypted, 7 days of backups). It's in private subnets and accepts connections only from the API and the worker. TLS is verified against Amazon's RDS certificates.
- **Public address**: an API Gateway HTTP API with HTTPS. It reaches the API privately through a VPC link, answers CORS for the website and `localhost:5173`, and caps traffic at 50 requests a second (bursts of 100). The API trusts exactly one forwarding hop (`TRUST_PROXY_HOPS=1`), so callers can't fake their address to dodge rate limits.
- **Sign-in**: a Cognito user pool, email and password with the email confirmed. The website sends the **ID token** as the bearer token. Google sign-in and magic links come next.
- **Secrets**: the database password is generated into `dettypot/<env>/db`. The Paystack, Google and Anthropic keys are in `dettypot/<env>/app`, uploaded by `scripts/put-keys.mjs`. Containers get only the secrets' names and read them at startup (`backend/src/secrets.ts`); no secret value is in a template, a task definition or this repo.
- **Logs**: CloudWatch, `/dettypot/<env>/api` and `/dettypot/<env>/worker`, kept a month.

It's built to be cheap. There's **no NAT gateway** (about $35 a month saved): the containers sit in public subnets with public addresses but accept traffic only from API Gateway. There's **no load balancer** (about $20 a month saved): API Gateway reaches the API through the VPC link.

## Cost (dev)

Rough monthly figures from AWS's eu-west-1 on-demand prices. Check the bill once it's running.

| Item | ≈ per month |
|---|---|
| RDS `db.t4g.micro` + 20 GB storage | $15 |
| Two Fargate containers (Graviton, 0.25 vCPU / 0.5 GB) | $15 |
| Two public IPv4 addresses for the containers | $7 |
| Secrets Manager (2 secrets), Cloud Map, logs, ECR | $3 |
| API Gateway, Cognito | ≈ $0 at this traffic (Cognito's first 10,000 monthly users are free) |
| **Total** | **≈ $40** |

Claude, Google Maps and Paystack bill separately.

## Everyday: deploying

Merging to `main` deploys dev (`.github/workflows/deploy-dev.yml`) when it touches `backend/` or `infra/`:

1. Builds the backend image on an Arm runner and pushes it to ECR, tagged with the commit.
2. `cdk deploy DettyPot-dev -c imageTag=<commit>`. CloudFormation waits until the new containers are healthy, and rolls back if they aren't.
3. Checks `/health/ready` on the public address.

You can also run it from the Actions tab (**deploy-dev → Run workflow**). An environment only exists in the CDK app when an `imageTag` is given, so a deploy without one can't put the wrong code live.

## Changing keys

```
aws sso login --profile dettypot
cd infra && node scripts/put-keys.mjs dev --profile dettypot
```

It reads `backend/.env` and refuses a live Paystack key outside prod. Containers read keys when they start, so restart them to pick new ones up:

```
aws ecs update-service --cluster dettypot-dev --service api --force-new-deployment --profile dettypot
aws ecs update-service --cluster dettypot-dev --service worker --force-new-deployment --profile dettypot
```

## First-time setup (done once per AWS account)

```
aws sso login --profile dettypot
cd infra && npm ci
npx cdk bootstrap aws://<account id>/eu-west-1 --profile dettypot
npx cdk deploy DettyPot-shared --profile dettypot
node scripts/put-keys.mjs dev --profile dettypot
gh variable set AWS_DEPLOY_ROLE_ARN --body "<DeployRoleArn output from DettyPot-shared>"
```

Then run **deploy-dev** from the Actions tab, or merge to `main`.

## Checking on it

- Address, sign-in IDs: the `DettyPot-dev` stack's outputs (CloudFormation console, or `infra/outputs.json` in the deploy job's log).
- Logs: CloudWatch → Log groups → `/dettypot/dev/api`.
- API docs (dev only): `<ApiUrl>/docs`.

## Tests

`npm test` checks the templates for what matters: no NAT gateway or load balancer, nothing reachable from the internet except through API Gateway, a private, encrypted, backed-up database, no secret values in task definitions, migrations before every start, and a deploy role only `main` in this repository can use. `npm run synth` also runs CDK's template validation, which fails the build on anything CloudFormation would reject.
