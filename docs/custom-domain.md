# New Oregon Dev hostname and GoDaddy DNS

Owner: SolluCIO Cortex-Dev account **909762691423**. Workloads remain in **us-west-2**. DNS for `solluciopartners.com` stays in GoDaddy; no Route53 hosted zone or nameserver migration is needed.

Sanjay confirmed these new hostnames:

| Purpose | Hostname | Destination after acceptance |
|---|---|---|
| User-facing application | `cortex-dev.solluciopartners.com` | Existing CloudFront distribution |
| Backend origin | `cortex-dev-origin.solluciopartners.com` | New public-subnet HTTPS ALB |

The existing UI is on `cortex-ui-mvp.vercel.app` without an organization custom domain. This is a new AWS endpoint, not a DNS cutover from Vercel. Existing Vercel and generated CloudFront access remain available during acceptance. Ohio retirement remains a separate manual action.

## 1. Request certificates without changing the running app

[certificates.ts](../infra/lib/certificates.ts) defines separate retained, DNS-validated, nonexportable ACM certificate stacks containing no workload, Route53 or IAM resources:

- `cortex-dev-viewer-certificate` in **us-east-1** for CloudFront.
- `cortex-dev-origin-certificate` in **us-west-2** for the ALB.

The viewer certificate is the required CloudFront service exception to the Oregon workload rule. No application, database, parser or file storage moves to us-east-1. See [CloudFront certificate-region requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html).

Dev's names are in `infra/environments/dev.json` under `dns`. They do not activate an alias, change S3 CORS or alter the current origin. The certificate app is separate from normal release synthesis/deployment, so a pending GoDaddy validation does not block application updates.

From the backend root, synthesize without credentials/lookups:

```bash
npm ci --prefix infra
CDK_DEFAULT_ACCOUNT=909762691423 \
AWS_EC2_METADATA_DISABLED=true \
npm run synth:certificates --prefix infra -- \
  -c environment=dev --no-lookups --quiet
```

Other environments must supply their own distinct `viewerDomain`/`originDomain` context values or environment configuration. The app refuses the wrong configured account, service region, wildcard, URL or malformed hostname.

Certificate bootstrap uses a separately authenticated Cortex-Dev administrator/approved certificate provisioning identity. The normal workload CloudFormation role does not currently grant ACM provisioning permissions, and the existing `apply-stack.mjs` helper assumes that role and Oregon. Do not silently broaden that role or change its region guard to bootstrap these independent certificate stacks.

Before creating each stack, verify STS account909762691423, validate its synthesized template in the corresponding region and review a CREATE change set. The expected change is exactly one Add of `AWS::CertificateManager::Certificate`. Execute that reviewed change set without waiting for stack completion. Reuse an existing matching request if present; do not create duplicate certificates or replace a certificate attached to a live endpoint.

## 2. Add the exact ACM validation CNAMEs in GoDaddy

While each stack is creating, use CloudFormation `list-stack-resources` to find its certificate physical ARN, then ACM `describe-certificate` in that certificate's region. Copy `DomainValidationOptions[].ResourceRecord` exactly. Do not invent the underscore-prefixed tokens.

In GoDaddy's `solluciopartners.com` zone, create **CNAME** records. The **Name/Host** field is the ACM record name with `.solluciopartners.com.` removed; **Value/Target** is the full ACM validation target. Preserve leading underscores. Use the default TTL (or600seconds if available). Do not append the zone twice or add URL schemes/paths.

Keep the validation records after issuance so ACM can renew the certificates. Validation records authorize certificate issuance; they do not route user traffic. Domain CAA restrictions, if introduced later, must allow the issuing Amazon CA.

With external DNS, `CREATE_IN_PROGRESS` and ACM `PENDING_VALIDATION` are expected until the CNAMEs resolve and ACM issues the certificate. This is not a failed application deployment. See [ACM DNS validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html) and [CloudFormation external-validation behavior](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-certificatemanager-certificate.html).

## 3. Configure routing only after validation

This phase remains pending until certificates are ISSUED and the revised topology is reviewed/deployed:

1. Add a new internet-facing ALB across both public subnets with HTTPS443 and the Oregon origin certificate. Keep Fargate tasks private and RDS isolated. Restrict ALB ingress to the AWS-managed CloudFront origin-facing prefix list; require a generated secret origin header, with default denial for other requests. Keep the existing private ALB while its CloudFront VPC-origin references still exist.
2. Provide the new public ALB's actual DNS name for GoDaddy CNAME **`cortex-dev-origin`**. Do not point this name at the current internal ALB or at CloudFront. The public ALB DNS value cannot be supplied before that resource exists.
3. After origin DNS resolves, verify origin TLS and authorized forwarding. Add the custom viewer alias and us-east-1 certificate to the existing CloudFront distribution, switch `/api/*` to the HTTPS-only custom origin, preserve authenticated-request headers/caching rules and service timeouts, and update document-bucket CORS to allow the new viewer origin while keeping existing accepted origins.
4. Provide/activate GoDaddy CNAME **`cortex-dev`** → **`d3ni3zlrnsq9j7.cloudfront.net`** only when CloudFront has the alias and issued certificate. An early CNAME does not by itself enable custom-hostname HTTPS. No Vercel record needs changing.
5. Verify DNS, certificates, TLS, app/login, attachments, persistent uploads/citations, API streaming and direct-origin denial. Confirm private task placement and unchanged RDS/data protections. Only after the distribution finishes its switch and acceptance passes may the obsolete Oregon private-origin resources be retired through a separately reviewed cleanup.

The origin-access secret must stay in approved secret storage/configuration; never put its value in this runbook, PR text, DNS records or public outputs. This phase is not part of the certificate-only stack execution. Existing origin behavior remains as documented in the [guidebook compliance plan](aws-guidebook-compliance-plan.md) until live evidence confirms the transition.
