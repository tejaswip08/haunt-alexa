# Deploying Haunt (not done yet: needs your approval)

Nothing in this folder has been run. Every command below creates or changes AWS resources, and several cost money every hour. Read the cost section first.

**State on Oct 17**, from read-only checks in the project's AWS account (us-east-1):

| Resource | State |
|---|---|
| DynamoDB `haunt-stories` | **Exists.** On-demand, TTL on, deletion protection on, 25 stories expiring Dec 1, 2026 |
| The account's default VPC | **Exists, reused.** Public subnets in 6 availability zones and an internet gateway, which Express Mode requires |
| IAM role `ecsInfrastructureRoleForExpressServices` | **Exists.** Trusted by `ecs.amazonaws.com`; AWS managed `AmazonECSInfrastructureRoleforExpressGatewayServices` |
| IAM role `haunt-execution` | **Exists.** Trusted by `ecs-tasks.amazonaws.com`; AWS managed `AmazonECSTaskExecutionRolePolicy` plus inline `haunt-read-mcp-token` (can read `haunt/mcp-tokens` only) |
| IAM role `haunt-task` | **Exists.** Trusted by `ecs-tasks.amazonaws.com`; inline `haunt-runtime` from `task-role-policy.json`. IAM policy simulator confirms access only to the Haiku 4.5 profile, Polly, Transcribe streaming and items in `haunt-stories`. |
| Secret `haunt/mcp-tokens` | **Exists.** Look up its ARN when needed (step 5). One random bearer token, never printed. Readable only by `haunt-execution`. About $0.40/month. |
| ECR repositories, ECS clusters or services, budgets | None |

Express Mode is available in us-east-1, and the installed AWS CLI (2.37.9) has the `create-express-gateway-service` commands.

## What gets deployed

One container serves:
- the website, including `/tv` and `/play`
- the public MCP endpoint (`/mcp`)
- Haunt's own pages' MCP route (`/api/mcp`)
- the simulator APIs (`/api/*`)

It's built from the repository's `Dockerfile`, runs as the unprivileged `node` user, and contains no credentials.

| Resource | Why | Notes |
|---|---|---|
| ECR repository `haunt` | Container image | Private, scan on push, versioned tags (`v1`, `v2`…) |
| IAM role `ecsInfrastructureRoleForExpressServices` | Lets ECS create and manage the service's load balancer, target groups, security groups and scaling | Trust `ecs.amazonaws.com`; AWS managed policy `AmazonECSInfrastructureRoleforExpressGatewayServices` |
| IAM role `haunt-execution` | Pulls the image, writes logs, reads the MCP token secret at startup | Trust `ecs-tasks.amazonaws.com`; AWS managed `AmazonECSTaskExecutionRolePolicy` plus `execution-role-secret-policy.json` (one secret only) |
| IAM role `haunt-task` | Haunt's own AWS access at runtime | `task-role-policy.json`: Bedrock Haiku 4.5 profile only, Polly synthesis, Transcribe streaming, DynamoDB on `haunt-stories` only. IAM Access Analyzer: no findings. |
| Secrets Manager secret `haunt/mcp-tokens` | Bearer tokens for external MCP clients | Injected as `HAUNT_MCP_TOKENS` by ECS; never in the image, the input file or the logs |
| ECS Express Mode service `haunt` | Runs the container behind an internet-facing load balancer with HTTPS, on a URL like `https://haunt-xxxx.ecs.us-east-1.on.aws/` | `express-service.json`: **ARM64 (Graviton)**, 0.5 vCPU / 1 GB, **1–2 tasks** (Express Mode's default auto scaling is capped), port 3001, health check `/api/health`. Express Mode adds canary deployments and 5XX rollback alarms. |
| Created by Express Mode | Application Load Balancer, listeners and TLS certificate, target group, security groups, CloudWatch log group, scaling policy | Set log retention to 14 days afterwards |
| AWS Budget | Spending alert | For example $25/month, email alert |

### DynamoDB table

One table, partition key only:

| Attribute | Type | Purpose |
|---|---|---|
| `id` (partition key) | String | `story#<storyId>` or `library#<storyId>` |
| `story` / `entry` | Map | The story, or a published episode |
| `version` | Number | Increases on every story write; writes are conditional on it, so two instances can't overwrite each other |
| `status`, `updatedAt` | String | For inspection |
| `expiresAt` | Number (epoch seconds) | DynamoDB TTL deletes stories `HAUNT_STORY_TTL_DAYS` after their last turn (45 in production; 0 = keep forever). The 25 migrated stories were set to expire on Dec 1, 2026. Library entries have no `expiresAt` and are kept. |

No indexes are needed: stories are read by id, and the library (a handful of items) is scanned with pagination. No audio is ever stored: recordings are transcribed in memory and dropped.

### MCP access

| Route | Who | Protection |
|---|---|---|
| `https://<service-url>/mcp` | External MCP clients (MCP Inspector, Claude, VS Code; Alexa+ only after Amazon grants add-on access and the server is registered) | `Authorization: Bearer <token>` from `HAUNT_MCP_TOKENS`. **Closed** in production when no token is set. Open CORS (tokens aren't cookies). Rate limit 120 per minute / 2,000 per hour per IP. 256 KB body limit. |
| `https://<service-url>/api/mcp` | Haunt's own `/play` and `/tv` pages | Same origin plus Haunt's client header, plus the same rate and size limits. It can't use a secret, because these are public web pages. It offers exactly what the public website already offers. |

Every MCP request gets a fresh, stateless server, so independent clients never share state. Story state lives in DynamoDB, under version checks.

## Estimated cost (us-east-1, list prices, before any Free Tier)

These are estimates from public list prices. Check them in the [AWS Pricing Calculator](https://calculator.aws/) before approving.

**Fixed, while it runs (whether or not anyone plays):**

| Item | Estimate |
|---|---|
| Fargate ARM64 (Graviton) 0.5 vCPU + 1 GB, 1 task 24×7 (about $0.0198/hour) | ≈ $14.40 / month (up to ≈ $29 if busy traffic keeps it scaled to the 2-task cap). The same size on x86_64 would be about $18. |
| Application Load Balancer (hourly + minimum capacity units) | ≈ $18–22 / month |
| Public IPv4 addresses (load balancer and task, about $0.005/hour each) | ≈ $7–11 / month |
| CloudWatch logs (small volume, 14-day retention) | ≈ $1 / month |
| ECR storage (one image, about 1.1 GB unpacked, a few hundred MB compressed in ECR) | ≈ $0.05 / month |
| Secrets Manager (1 secret) | $0.40 / month |
| DynamoDB storage (about 1 MB today) | under $0.01 / month |
| **Fixed total** | **≈ $41–51 / month** (up to ≈ $66 at the 2-task cap) |

**Usage-based (per short, 4-scene story):**

| Item | Estimate |
|---|---|
| Bedrock Claude Haiku 4.5 (measured: about 30k input / 6k output tokens with pre-written branches) | ≈ $0.06 (≈ $0.02 with `HAUNT_PREWRITE=off`) |
| Polly generative narration (about 2,500 characters) | ≈ $0.08 |
| Transcribe streaming | $0 while `HAUNT_STT=off` (the production default in `express-service.json`); under $0.01 per story if switched on |
| DynamoDB on-demand (about 6 writes of about 30 KB plus reads) | under $0.001 |
| Data transfer out | small; typically within AWS's monthly included transfer |
| **Per story** | **≈ $0.15** |

Running from now until judging ends (about Nov 20, 5 weeks) costs about **$50–60 fixed plus about $0.15 per story played**.

## First deployment and HAUNT_PUBLIC_URL (bootstrap)

Production refuses to start without `HAUNT_PUBLIC_URL`, because the device-sign-in link must point at the real public address. The public address only exists after the service is created, so the first revision uses a bootstrap mode, and the health probes stay reachable while nothing else is served:

1. **Revision 1 (bootstrap):** create the service with `HAUNT_BOOTSTRAP=1` and no `HAUNT_PUBLIC_URL`. Health and readiness answer. Every other route answers 503 "being set up", so no listener is served and no paid call is made.
2. Read the service's public address from the service (for example `https://haunt-xxxx.ecs.us-east-1.on.aws`).
3. **Revision 2 (live):** set `HAUNT_PUBLIC_URL` to that address and remove `HAUNT_BOOTSTRAP`. The server refuses to start if both are set, so bootstrap can't be left on by mistake.
4. Check `/api/health` and `/api/ready`, then `/fire-tv/`.

The address is never taken from the request's Host header. A spoofed host could change the link shown on the TV.

Production also refuses to start unless the Converse API is set (`HAUNT_BEDROCK_API=converse`), and per-listener daily caps (`HAUNT_DAILY_USER_TTS_REQUESTS`, `HAUNT_DAILY_USER_AGENT_REQUESTS`) and global caps (`HAUNT_DAILY_TTS_REQUESTS`, `HAUNT_DAILY_AGENT_REQUESTS`) apply to the paid routes. Their defaults are in `apps/server/src/config.ts`.

**Still to verify live (not done):** the IAM policy must allow `bedrock:InvokeModel` for the Haiku inference profile in every region the profile routes to; the daily counters' conditional behaviour across several tasks; and the first-revision health behaviour.

## Steps (in order, each needs your approval)

Prerequisites:
- Docker (or Finch) installed.
- A valid SSO session: `aws sso login --profile haunt`.

Set the profile first, then look up the account id from it. These are two commands because a single `export` line would run the lookup before `AWS_PROFILE` takes effect.

```bash
export AWS_PROFILE=haunt AWS_REGION=us-east-1
```

```bash
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text) && echo "$ACCOUNT_ID"
```

The `deploy/*.json` files use the placeholders `ACCOUNT_ID` and `SECRET_ARN`; the commands below fill them in from these variables when they write temporary copies to `/tmp`. The files in the repository keep the placeholders.

**0. Budget alert** (free for the first two budgets): create it in the console under Billing → Budgets, or ask me to prepare the command.

**1. Build and test the image locally** (free):

```bash
docker build -t haunt .
```

```bash
docker run --rm -p 3001:3001 -e HAUNT_PROVIDER=mock -e HAUNT_TTS=browser haunt
```

Then check http://localhost:3001/api/health, http://localhost:3001/api/ready and http://localhost:3001/tv.

**2. Table: done (Oct 17).** `haunt-stories` exists with TTL on `expiresAt` and deletion protection on. Don't re-create it.

**3. Migration: done (Oct 17).** All 25 local stories were copied and verified. Re-running it is safe (insert-only) but not needed.

**4. IAM roles: done (Oct 17).** All three roles exist with their policies, verified with read-only IAM calls and the IAM policy simulator. **Don't run the commands below during this deployment.**

| Role | Trusted by | Policies | Least privilege (simulator) |
|---|---|---|---|
| `ecsInfrastructureRoleForExpressServices` | `ecs.amazonaws.com` | AWS managed `AmazonECSInfrastructureRoleforExpressGatewayServices` | Used only by ECS to manage the service's load balancer, networking and scaling |
| `haunt-execution` | `ecs-tasks.amazonaws.com` | AWS managed `AmazonECSTaskExecutionRolePolicy`; inline `haunt-read-mcp-token` | Can read `haunt/mcp-tokens` and no other secret; no DynamoDB access |
| `haunt-task` | `ecs-tasks.amazonaws.com` | Inline `haunt-runtime` (`task-role-policy.json`) | Allowed: Haiku 4.5 through the `us.` profile, Polly synthesis, Transcribe streaming, items in `haunt-stories`. Denied: other models, other tables, deleting the table, reading the MCP secret, IAM changes. |

<details>
<summary>Recovery only: recreate the roles if they were deleted</summary>

Run these only after confirming a role is missing (`aws iam get-role --role-name <name>` returns `NoSuchEntity`). IAM changes take about a minute to propagate.

```bash
aws iam create-role --role-name ecsInfrastructureRoleForExpressServices --assume-role-policy-document file://deploy/ecs-infrastructure-trust-policy.json
```

```bash
aws iam attach-role-policy --role-name ecsInfrastructureRoleForExpressServices --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices
```

```bash
aws iam create-role --role-name haunt-execution --assume-role-policy-document file://deploy/ecs-trust-policy.json
```

```bash
aws iam attach-role-policy --role-name haunt-execution --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
```

```bash
aws iam create-role --role-name haunt-task --assume-role-policy-document file://deploy/ecs-trust-policy.json
```

```bash
sed "s/ACCOUNT_ID/$ACCOUNT_ID/g" deploy/task-role-policy.json > /tmp/haunt-task-policy.json && aws iam put-role-policy --role-name haunt-task --policy-name haunt-runtime --policy-document file:///tmp/haunt-task-policy.json
```

</details>

**5. MCP token secret: done (Oct 17).** `haunt/mcp-tokens` exists. Secrets Manager gives its ARN a random suffix, so look it up with the command below instead of copying it from anywhere. It holds one random 64-character bearer token, generated locally and never printed. Only `haunt-execution` can read it; ECS injects it into the container as `HAUNT_MCP_TOKENS`, so it never appears in the image, `express-service.json` or the logs. **Don't recreate it.**

Before step 7, look up the existing secret's ARN (read-only), because step 7 fills it into the service definition:

```bash
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id haunt/mcp-tokens --query ARN --output text) && echo "$SECRET_ARN"
```

To give the token to an MCP client, read it yourself when you need it, in a private terminal; don't paste it into chats, issues or files:

```bash
aws secretsmanager get-secret-value --secret-id haunt/mcp-tokens --query SecretString --output text
```

<details>
<summary>Recovery only: recreate the secret if it was deleted</summary>

Run these only after confirming it's gone (`describe-secret` returns `ResourceNotFoundException`). A deleted secret stays in a 7–30 day recovery window; restore it with `aws secretsmanager restore-secret --secret-id haunt/mcp-tokens` instead of creating a new one. A recreated secret gets a new ARN and a new token, so every MCP client needs the new token.

```bash
SECRET_ARN=$(aws secretsmanager create-secret --name haunt/mcp-tokens --secret-string "$(openssl rand -hex 32)" --query ARN --output text)
```

```bash
sed "s#SECRET_ARN#$SECRET_ARN#" deploy/execution-role-secret-policy.json > /tmp/haunt-secret-policy.json && aws iam put-role-policy --role-name haunt-execution --policy-name haunt-read-mcp-token --policy-document file:///tmp/haunt-secret-policy.json
```

</details>

**6. Build and push the image.** Docker Desktop is installed and working on this Mac (Apple silicon, engine 29.8.2). The image is built natively for **linux/arm64**, matching the Graviton service, so no emulation is needed. A local `haunt:dev` build has already passed its in-image tests and a container smoke test.

```bash
aws ecr create-repository --repository-name haunt --image-scanning-configuration scanOnPush=true
```

```bash
aws ecr get-login-password | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com
```

```bash
docker buildx build --platform linux/arm64 -t $ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/haunt:v1 --push .
```

**7. Create the Express Mode service** from `deploy/express-service.json`. It pins ARM64 (Graviton), 0.5 vCPU / 1 GB and 1–2 tasks; Express Mode's defaults are x86_64 and scale further. The image architecture must match `cpuArchitecture`: an amd64 image on an ARM64 service (or the reverse) fails to start with an exec format error.

```bash
sed -e "s/ACCOUNT_ID/$ACCOUNT_ID/g" -e "s#SECRET_ARN#$SECRET_ARN#" deploy/express-service.json > /tmp/haunt-express.json && aws ecs create-express-gateway-service --cli-input-json file:///tmp/haunt-express.json --monitor-resources
```

The command prints the service ARN and URL when it's done. If it fails right after step 4 with an assume-role error, wait a minute and run it again.

**8. Set log retention** to 14 days on the service's log group, in CloudWatch → Log groups.

**9. Verify from outside** (pending until it's deployed):

```bash
curl -s https://<service-url>/api/health
```

```bash
curl -s https://<service-url>/api/ready
```

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<service-url>/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

That should print **401** (no token).

```bash
npx @modelcontextprotocol/inspector
```

Choose Streamable HTTP, URL `https://<service-url>/mcp`, header `Authorization: Bearer <token>`. You should see 6 tools.

**10. Rebuild the Fire TV app** with `-PhauntUrl=https://<service-url>/tv`.

## Rollback

- **Bad release:** Express Mode deploys updates as canaries and rolls back automatically on 5XX alarms. To roll back by hand, point the service at the previous tag: `aws ecs update-express-gateway-service --service-arn <arn> --primary-container '{"image":"<account>.dkr.ecr.us-east-1.amazonaws.com/haunt:v1"}' --monitor-resources`. The URL stays the same. Always tag images with versions, never only `latest`.
- **Bad data:** stories carry a `version`. Turning on DynamoDB point-in-time recovery (extra cost, about $0.20/GB per month) would allow restores; it's not enabled in this plan.
- **Leaked token:** add a new token to the secret (comma-separated), restart the service, move clients over, then remove the old one.

## Turning it off

1. Delete the Express Mode service, which removes its load balancer and stops the hourly charges: `aws ecs delete-express-gateway-service --service-arn <arn> --monitor-resources`.
2. Optionally, `aws ecr delete-repository --repository-name haunt --force`.
3. Optionally, delete the `haunt/mcp-tokens` secret (`aws secretsmanager delete-secret --secret-id haunt/mcp-tokens`, which waits 7–30 days before final deletion) and the three IAM roles (detach or delete their policies first).
4. Delete the table only once you no longer need the stories. The `haunt-stories` table has **deletion protection enabled**, so `delete-table` is refused until an operator turns protection off, as a separate, intentional step:

   ```bash
   aws dynamodb update-table --profile haunt --region us-east-1 --table-name haunt-stories --no-deletion-protection-enabled
   ```

   Wait for the table to return to `ACTIVE` before deleting it:

   ```bash
   aws dynamodb wait table-exists --profile haunt --region us-east-1 --table-name haunt-stories
   ```

   ```bash
   aws dynamodb delete-table --profile haunt --region us-east-1 --table-name haunt-stories
   ```

   Deletion protection only blocks deleting the table itself. While it's on, the app's item-level operations (reading, writing, updating and deleting stories and library entries) keep working, and TTL keeps expiring stories on `expiresAt` as usual.

## Production checklist

- [ ] Budget alert set
- [ ] `HAUNT_MCP_TOKENS` injected from Secrets Manager; `/api/health` shows `"mcpAuth":"token"`
- [ ] `HAUNT_STORE=dynamodb`, `HAUNT_TABLE_NAME=haunt-stories`, TTL enabled; `/api/ready` shows `"ready":true`
- [ ] `HAUNT_TRUST_PROXY=1`, so rate limits see real client addresses
- [ ] Real contact address set in `apps/web/src/pages/Legal.tsx` (`CONTACT`)
- [ ] Fire TV APK rebuilt with the HTTPS URL
- [ ] Alexa+: still separate. Public hosting doesn't connect Haunt to Alexa+; that needs Amazon's add-on access and registration.

## Lambda artifact (`deploy/serverless/build/`)

The SAM template ships `CodeUri: build/` as the function's code. That directory is generated, not edited, and it is git-ignored. Regenerate it from the current source before every `sam deploy`:

```bash
npm run build:lambda
```

This builds the views (`scene.html`), then bundles `apps/server/src/lambda.ts` into one self-contained ESM file with the repository's esbuild, and copies the scene asset to the path the runtime reads (`apps/views/dist/scene.html`). It fails with a nonzero exit code if bundling or a copy fails, and it leaves the previous artifact in place in that case. Its output layout:

```
build/package.json                       { "type": "module" }
build/apps/server/src/lambda.js          the handler (apps/server/src/lambda.handler)
build/apps/views/dist/scene.html         read at runtime from ROOT_DIR/apps/views/dist
```

To build somewhere else first (for review), pass a directory: `node scripts/build-lambda.mjs /tmp/haunt-lambda`. The bundle contains every npm dependency it imports, including the S3 SDK, the presigned-POST packages, and `@codegenie/serverless-express`. It must start with no `node_modules` beside it, and the build checks that before it writes anything.
