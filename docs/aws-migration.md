# Cortex AWS migration and operation

Cortex-Dev account **909762691423**, Oregon **us-west-2**. Never use an ambient AWS profile: the developer laptop's default belongs to a different business. Commands that mutate AWS verify STS against the selected environment. Human access should use a separate SolluCIO SSO profile. CI uses GitHub OIDC, never stored AWS access keys.

## Architecture and ownership

**October16 update:** Live Foundation/Data/Operations are healthy; application services and Delivery are not deployed. Sanjay requested exact guidebook network alignment. The revised target and acceptance gates are in [aws-guidebook-compliance-plan.md](aws-guidebook-compliance-plan.md): central Flow Logs, private signer Lambda, empty default group (confirmed), and a restricted public-tier HTTPS ALB. The architecture described below reflects the original implemented templates until that plan is applied.

CDK in `infra/` produces CloudFormation templates. Foundation owns the VPC (public NAT subnets, private application subnets, isolated database subnets), encryption key, ECR and deployment identities. Data owns private encrypted PostgreSQL 18, versioned private document/web/archive buckets, Cognito and upload-signing Lambda. Operations owns the ECS cluster and a short-lived database migration task. Application owns API/PostgREST sidecars, Docling, SQS worker, EventBridge upload events, queues and operational alarms. Delivery owns CloudFront, its private ALB VPC origin, and static routing.

Only CloudFront is public. PostgREST binds to loopback inside each task. The database accepts TLS only from the application and operations security groups. Documents use short-lived signed URLs; the browser uploads straight to S3 with bound size/type/checksum, avoiding API proxy upload limits. S3 emits an EventBridge event into SQS; ingestion claims the document atomically, maintains heartbeats, retries and dead-letters failures. Duplicate events are expected. Incomplete browser uploads can be retried; metadata waiting for an upload must not be treated as ingested.

CloudFront serves the Next static export and `/api/*` from the same origin. Introducing future Next server actions, middleware, SSR or API routes requires revisiting this hosting decision. The legacy Supabase callback/document/admin wrappers have been replaced with the existing API-backed screens. Production needs its custom domain, ACM certificate, stricter TLS policy, WAF/rate controls, approved alert subscribers, backup restore exercise and operational access review before release. The generated CloudFront domain is for the first Dev test.

## Accounts

| Environment | Account | VPC | Availability |
|---|---|---|---|
| dev | 909762691423 | 10.10.0.0/16 | Single RDS, one NAT, one API/worker/parser |
| test | 223323955607 | 10.20.0.0/16 | Separate account; bootstrap required |
| prod | 474711723859 | 10.30.0.0/16 | Multi-AZ RDS, three NATs, two API tasks; bootstrap required |

Test and Prod configuration is reusable; deploying Dev does not provision those accounts or authorize copying customer data there. Each needs its own roles, secrets, parser/PostgREST images, approvals, domains and test dataset. Expected ongoing Dev costs include NAT + traffic, internal ALB, RDS, continuously running Fargate (especially the 2 CPU/4 GB parser), ECR storage, CloudWatch, S3, CloudFront and OpenAI usage. These are not a free or scale-to-zero deployment. No exact monthly cost is promised without a workload estimate. Budget notifications require an owner and delivery address.

## Migration evidence and limits

The Ohio snapshot `cortex-dev-oregon-source-20261015` was copied to encrypted Oregon snapshot `cortex-dev-oregon-20261015`. `infra/environments/dev.json` deliberately preserves its snapshot ARN: changing/removing this property can replace a restored CloudFormation database. State-bearing resources are retained and the deployment helper refuses their replacement or resource removal. This is a safety guard, not a substitute for reviewing change sets.

Before application writes, all **25 public tables / 8,404 rows** matched source counts and sorted row fingerprints. This includes 31 document records and 1,336 chunks. All **35 current S3 objects** were copied and independently compared using full SHA-256; the source had no noncurrent object versions at inventory time. 15 Cognito user metadata records were archived. Evidence lives in `s3://cortex-migration-dev-909762691423-us-west-2/verification/`, `cognito/users.json` and `schema/`. Source rows and file bodies were not committed to Git. The private archive is encrypted and versioned; do not make it public.

This is a verified point-in-time copy, **not continuous replication**. Later writes in Ohio are not automatically reflected in Oregon. Pick a write cutoff before retirement. If Ohio receives additional writes, compare them and perform an explicitly reviewed final synchronization; never overwrite a now-active Oregon database with an old snapshot. Any pre-existing missing file references or incomplete source documents need separate reconciliation.

A new Oregon Cognito pool was created and all 15 archived users were transferred with a temporary initial password, as requested by Sanjay. Every user is in `FORCE_CHANGE_PASSWORD` and must choose an individual password through the existing Cortex login page. Disabled users remain disabled. Passwords are never stored in the repo or transfer archive. Immutable source issuer/subject metadata links the new identity to the existing application account, roles and history on first sign-in. No email-only identity matching is permitted. The Ohio password bridge has been removed from the infrastructure and is not required. Password reset uses Oregon Cognito directly. Existing Ohio credentials and the Ohio pool remain unchanged until manual retirement.

## Local development

Prerequisites: Node 24, Docker Compose, the two sibling checkouts on `aws-migration`, and a verified developer identity in Dev Cognito. Local data is synthetic in Docker PostgreSQL; file storage is local. Cognito and OpenAI remain real cloud dependencies. The local profile is explicitly rejected when `NODE_ENV=production`. Nothing opens public database access.

```sh
cd /Users/sanjay/Documents/work/sollucio/repositories/cortex-mvp
npm ci
npm --prefix ../cortex-ui-mvp ci
# No AWS needed: build schema and fixture in a local volume.
npm run setup:local -- --database-only
# Use the dedicated SolluCIO SSO profile, never the default profile.
AWS_PROFILE=<your-sollucio-dev-profile> npm run setup:local -- --email <your-verified-email>
npm run dev:local
# For uploads/parsing (cached parser image required):
npm run dev:local -- --documents
# Stop containers while keeping data:
npm run stop:local
```

The UI listens on 3003, API 8082, local PostgREST 3004 and optional parser 8091; the PostgreSQL port is loopback 5433. This avoids Francis's original processes on 3002/8081/3001/8090. Control-C stops the host processes; the data volume survives. Never use `docker compose down -v` unless intentionally discarding only these synthetic local fixtures.

Ignored `.local/dev/` files are generated with owner-only permissions. Do not copy Francis's production dataset or keys into committed fixtures. `--database-only` tests schema, roles and fixture setup; it does not start the complete UI or prove Cognito/OpenAI integration. Obtain the parser through Oregon ECR with SSO and tag it `cortex-parser:aws-local`, or build `docker build -t cortex-parser:aws-local parser`. The first parser build is large and downloads models. If Docker's desktop credential helper hangs, diagnose the helper; this migration used a temporary isolated Docker config, leaving global credentials unchanged.

## Releases

Both repositories have `.github/workflows/aws.yml`. Pushes to `aws-migration` verify and deploy Dev. Pull requests verify only. Manual dispatch supports an environment after the workflow exists on the default branch and that account is bootstrapped. Do not merge these branches automatically. Configure GitHub `dev`, `test`, `prod` environments with deployment branch rules and required reviewers for Test/Prod; organization administrators must enforce these settings. Separate repositories deploy independently through the stable API contract: deploy compatible backend changes before a frontend depending on them. Breaking changes require an expand/contract release across both repositories.

Backend builds ARM64 on the GitHub ARM runner, pushes an immutable tag, synthesizes templates, applies Data/Operations, runs the private migration task, then applies Application/Delivery and checks HTTPS health. Parser and PostgREST versions are pinned in environment JSON and do not rebuild on each app release. Changes to these components require separately built, tested immutable images and an explicit environment version update. Foundation/IAM changes are a separate reviewed infrastructure operation. A release refuses data-resource replacements/removals. It does not automatically migrate from Supabase or perform a later Ohio data resync.

Frontend builds once, stores the static artifact, assumes only its web deployment role, uploads hashed assets before HTML and invalidates CloudFront. It keeps older hashed files for active tabs. Reverting the source commit and redeploying is the normal frontend rollback; bucket versions are available for recovery. Backend ECS has deployment circuit breakers and retains task definitions. To roll back, redeploy a previously tested immutable API tag. Database migrations must be backward compatible: rolling back an image does not undo SQL or data writes. Restoring RDS is a separate, reviewed recovery operation.

Use `npm run build --prefix infra`, `npm test --prefix infra`, and `npm run test:migration` before deployment. A fresh local schema verifies columns, constraints, functions, indexes and RLS against the captured baseline; database migrations record checksums and run under an advisory transaction lock. Do not edit an applied SQL file: add a new migration. The migration archive holds an Oregon schema export for recovery. CloudFormation lint tooling may lag new properties; document specific differences and confirm live AWS validation rather than broadly ignoring lint errors.

## User acceptance before retiring Ohio

Sign in with an existing account at the Oregon HTTPS URL; check roles/namespaces and prior chat history. Open representative existing originals/rendered files, ask questions with citations, and test a new upload through parsing to ready and retrieval. Check private mode and authorization using another role/namespace. Reload and verify persistence. Review both GitHub Actions runs and make one small deployment from each repository. Verify operational alarms have confirmed subscribers, DLQ recovery, backup restore, and a write cutoff/final data comparison. Then follow `ohio-retirement.md` yourself. No retirement action is part of automated deployment.
