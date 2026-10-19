# Test and Prod preparation

Owner: SolluCIO Cortex infrastructure. This is a preparation runbook, not authorization to provision an account. Updated October 19, 2026.

**Test and Prod deployment remain disabled in both repositories.** No resources, change sets, users, datasets, DNS records or GitHub environments are created by the preparation command. The existing push-to-Dev release remains enabled. Do not merge this prerequisite work as a claim that Test/Prod are deployed or production-ready.

## Accounts and planned topology

| Environment | Account | Region | VPC | AZs / NAT gateways | RDS / backups | Managed CloudWatch retention |
| --- | --- | --- | --- | --- | --- | --- |
| Dev | `909762691423` | `us-west-2` | `10.10.0.0/16` | 2 / 1 | Single-AZ / 7 days | 30 days |
| Test | `223323955607` | `us-west-2` | `10.20.0.0/16` | 2 / 1 | Single-AZ / 7 days | 30 days |
| Prod | `474711723859` | `us-west-2` | `10.30.0.0/16` | 3 / 3 | Multi-AZ / 35 days | 365 days |

Each AZ has a public, private application and isolated data subnet. Public subnets contain NAT gateways; the internal ALB, application tasks and upload signer use private application subnets without public workload IPs; RDS uses isolated data subnets. An S3 gateway endpoint handles S3 routes. AWS-managed S3, Cognito and CloudFront do not occupy these subnets.

All three environment files explicitly select `apiOrigin: private`, following Sanjay's October 19 decision. Test/Prod preparation uses one internal ALB and one CloudFront VPC origin, with no public ALB or origin hostname/certificate requirement. A custom browser hostname needs only a viewer certificate in us-east-1; the generated CloudFront address also works. Dev retains its existing unused public ALB until separate cleanup. This is a documented variation from the guidebook's public load-balancer tier. The current private origin uses HTTP port 80; privacy does not establish end-to-end application TLS.

Prod's defaults cost more: three NAT gateways, larger Multi-AZ RDS and two API tasks. Parser/worker remain one task each in current code; capacity, scaling and redundancy must be agreed before Prod enablement.

## What is prepared in code

- Account/region settings and separate CIDRs already exist. Test/Prod have `deploymentEnabled: false` in [environment configuration](../infra/environments/).
- [Deployment policy](../scripts/deploy/policy.mjs) is checked before AWS credentials are read by the standard release, image-push, database and stack-apply helpers. The workflow checks it before assuming an AWS role. Unknown environments fail instead of selecting Dev.
- Frontend publishing has an independent matching gate in its repository. Enabling one repository does not enable the other.
- Central flow-log templates now support all three exact source accounts. Destination permissions use account-specific prefixes and source-account/source-ARN conditions. The dedicated retained archive bucket keeps its 365-day lifecycle. No live archive-policy update has been applied by preparing these files.
- GitHub role templates trust the exact repository's environment subject, with audience `sts.amazonaws.com`. The alternative direct `dev` branch subject is removed from desired state. This IAM change takes effect only after a separately reviewed Foundation update.
- All seven managed Prod CloudWatch groups have `RetentionDays.ONE_YEAR`; Dev/Test retain 30 days. Service-created Lambda/RDS groups currently default to no expiry. Inventory them after deployment; see [log retention](log-retention.md).
- Pull requests run offline validation for every environment. Manual dispatch defaults to `prepare_only: true`, so the deployment job is skipped. Explicit deployment still encounters the Test/Prod gate.

These are repository safeguards, not an IAM/SCP boundary. A person with sufficient AWS permissions can bypass scripts using the CLI or direct CDK deployment. Do not use those alternatives to bypass the disabled-environment decision.

## Run preparation locally

From the backend repository, using Node 24 and installed dependencies:

```bash
npm ci
npm ci --prefix infra
npm run test:deployment
npm run build --prefix infra
npm test --prefix infra
npm run prepare:environments
```

To prepare only one environment:

```bash
npm run prepare:environments -- prod
```

No AWS login/profile is required. The command strips AWS/CDK session variables from its child process, disables credential-file/instance-metadata loading, supplies synthesis-only AZ context and uses CDK `--no-lookups`.

Output is ignored under `.local/preparation/`: separate full CloudFormation graphs for Dev/Test/Prod, certificate requests, the proposed central archive policy and `readiness.json`. The shared archive template is included in each environment's output for review; it is one shared stack, not three buckets. Test/Prod graphs exercise fresh databases, private ALBs/VPC origins and custom viewer aliases using reserved `.example.invalid` viewer hostnames, fictitious viewer certificate ARNs and image tags. No origin certificate request or public ALB is synthesized for Test/Prod. AZ names are offline fixtures, not a live availability/quota check. Even the Dev preparation output is marked as preparation-only; use the regular app for a real release.

**Do not deploy these output templates.** Each has `Metadata.CortexPreparationOnly: true`; `apply-stack.mjs` and the central logging helper refuse them. Never remove the marker to turn fixtures into deployment inputs. Real release synthesis uses `infra/bin/cortex.ts` and approved environment settings, with the separate certificate/central-logging entry points for their stacks.

## Remaining prerequisites and owners

| Prerequisite | Owner / required evidence |
| --- | --- |
| Account access | AWS admin supplies separate SSO profiles for Test, Prod and Log Archive; STS matches the exact account; Oregon service quotas/AZ availability are checked. No saved access keys in GitHub or repository files. |
| Organization controls | Organization admin reviews SCPs/service-linked-role permissions for the intended new Cortex resources. Tom confirmed that `aws-controltower-*` log groups are guardrail-managed and excluded in Vanta; the 365-day test is passing. Leave them alone. Apply one-year retention to Cortex-owned Prod log groups when deployed. |
| GitHub administration | Repository admin creates `dev`, `test`, `prod` environments in both repositories, selects allowed release references, configures approvals and prevents self-review/bypass where supported. Confirm private-repository plan support for protections. Merely naming an environment in YAML is not an approval gate. |
| Workflow availability | Admin agrees the default-branch/release-reference policy. `workflow_dispatch` must be present on the default branch to be available normally; do not deploy old default-branch application code by accident. |
| Domains and certificates | Choose the generated CloudFront address or approve a custom viewer hostname. A custom viewer needs a us-east-1 ACM certificate and GoDaddy validation/routing CNAMEs. Private API origins need no public origin hostname/certificate. No Test/Prod hostnames have been selected by this preparation. |
| Initial account foundation | Explicit provisioning approval, reviewed Foundation template/change set, no resource removals or stateful replacement. Current CDK uses `BootstraplessSynthesizer`; do not assume running `cdk bootstrap` provisions the Cortex foundation. |
| Initial images | Build/review ARM64 API, parser and PostgREST images and populate the destination environment's ECR repositories. Never use the API tag as a fallback parser/PostgREST image. |
| Data and identities | Approve fresh Test fixtures and the Prod data source; prove baseline migrations on an empty Test DB; create independent Cognito users/admin and test recovery email. No implicit copy of Dev documents/users/passwords. |
| Secrets | Populate environment-specific OpenAI secret and approved integration settings. Database/runtime/parser/origin signing values are generated independently by IaC. Keep all secret values out of JSON examples and workflow logs. |
| Central logging | Authorize Log Archive policy update first, then each source Foundation. Verify fresh account-specific Parquet objects and delivery status. Prepared policies do not prove logs are being delivered. |
| Operations | Confirm alarm recipients and notification delivery; approve scaling, WAF/runtime monitoring, budgets, backup/restore and recovery objectives. Record a restore exercise before Prod acceptance. |
| Release promotion | Implement and verify same-artifact promotion described below before enabling Test/Prod. Current dispatch still rebuilds an API/frontend release; that is not artifact promotion. |

The October 19 account inspection found no Cortex Prod stacks or VPC flow logs in Oregon. Log Archive's live dedicated bucket already had a 365-day lifecycle but permitted Dev only. A future operator must recheck live state rather than treating this dated observation as a continuing guarantee.

## Release promotion contract — still required before enablement

Keep source on the reviewed `dev` baseline; extra long-lived `test` and `prod` branches are not necessary. A successful Dev release should produce an immutable release manifest linking backend commit, infrastructure revision, API/parser/PostgREST digests, frontend commit/artifact checksum and migration versions. Backend and frontend are separate repositories: record the compatible pair explicitly.

The next release-workflow change must select a successful release, copy the exact approved image manifests into environment-specific ECR repositories and verify the destination digests. Download/verify the exact frontend build instead of rebuilding it. Current same-origin frontend API calls allow this artifact reuse. Protect active and rollback releases from ECR lifecycle cleanup; the current 30-image rule alone is not a rollback guarantee.

Use explicit image copying/promotion with the current `cortex-dev-*`, `cortex-test-*`, `cortex-prod-*` names. Native ECR replication preserves repository names and does not rename a Dev repository into a Test/Prod one. Promotion credentials and repositories need reviewed least-privilege permissions, not a wildcard cross-account role.

Prod deployment should require successful Test acceptance for the same manifest plus an authorized approval. GitHub admin settings, actual OIDC subject format and the configured AWS trust policy must agree. Neither a manually entered tag nor a green PR build establishes promotion provenance.

## Later provisioning sequence — do not execute during preparation

1. Obtain explicit approval for **Test** provisioning. Finish domain, data and GitHub decisions; implement/verify promotion; review the configuration/enablement PRs for both repos. Do not merely flip `deploymentEnabled` to true.
2. Review/apply the central Log Archive policy, then provision Test Foundation with the approved operator session. Publish initial images; provision Data; populate secrets.
3. Provision Operations, initialize the fresh private database, then deploy Application/Delivery with an internal ALB/VPC origin. Publish UI, finish optional viewer DNS and required viewer-origin CORS, and confirm HTTPS.
4. Verify login/reset, namespace isolation, document upload-to-ready, retrieval/chat/citations, network placement, central log objects, alerts and rollback. Capture exact successful deployment run IDs and the accepted release manifest.
5. Obtain separate **Prod** provisioning approval. Review the Prod plan/costs, enablement PRs and Test evidence. Provision the Prod equivalents and promote the accepted release.
6. Inventory **all** Prod CloudWatch groups for retention >=365 or no expiry, including RDS/Lambda groups. Verify central logging, backups/restore and browser flows before production acceptance. Track any organization-owned baseline exception separately.

Foundation, certificate and central-logging changes remain reviewed infrastructure operations, outside the normal API release helper. A dedicated infrastructure plan/apply workflow with a distinct approved identity is still required if these operations are to be automated; no such apply workflow is enabled by this PR.

## Evidence and limits

Deployment-gate tests use a fake AWS executable and verify that blocked Test/Prod helpers never call it, including from another working directory. Infra synthesis checks topology, log retention, protected state, exact OIDC subjects and account-scoped central delivery. These checks do not establish live SCP permissions, DNS, secrets, quotas, successful deployments or regulatory compliance.

See [runtime and recovery](runtime-and-recovery.md) for existing Dev releases and rollback limits. Reverting a container does not reverse database migrations; use compatible migrations and a separately reviewed restore procedure when needed.

References: [GitHub AWS OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws), [GitHub environment administration and plan limits](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments), [CloudFront ALB restrictions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/restrict-access-to-load-balancer.html), [ECR replication constraints](https://docs.aws.amazon.com/AmazonECR/latest/userguide/replication.html).
