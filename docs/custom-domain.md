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

Both certificates were ISSUED on 2026-10-16. Their ARNs and the hostnames are in `infra/environments/dev.json` (`certificates`, `dns`); [edge.ts](../infra/lib/edge.ts) validates them. `dns.apiOrigin` selects where CloudFront sends `/api/*`: `private` (the VPC origin) or `public` (the HTTPS origin hostname). Roll out in this order:

1. **Foundation first, as a separately reviewed operation.** The pipeline does not deploy foundation. This change grants the CloudFormation role `acm:DescribeCertificate` on this account's certificates and exports the public subnet IDs that the application stack now imports. Review the change set, then apply it with an approved Cortex-Dev administrator identity:
   `node scripts/deploy/apply-stack.mjs dev cortex-dev-foundation infra/cdk.out/cortex-dev-foundation.template.json`
2. **Phase A (`apiOrigin: "private"`), via the normal `dev` pipeline.** This creates the `cortex-dev/cloudfront-origin` secret and adds the viewer origin to document-bucket CORS. In [runtime.ts](../infra/lib/runtime.ts) it adds an internet-facing ALB in the public subnets: HTTPS 443 only, `ELBSecurityPolicy-TLS13-1-2-2021-06`, the Oregon origin certificate, ingress only from the CloudFront origin-facing prefix list, invalid header fields dropped, and default `403`. Only requests carrying `X-Cortex-Origin-Verify` with the secret value are forwarded to the API target group. Fargate tasks stay private. It also adds the `cortex-dev` alias and us-east-1 certificate to the existing distribution. `/api/*` stays on the VPC origin, so nothing changes for users yet.
3. **GoDaddy.** Send both CNAMEs: **`cortex-dev`** → **`d3ni3zlrnsq9j7.cloudfront.net`**, and **`cortex-dev-origin`** → the `PublicOriginDns` output of `cortex-dev-application`. Do not point `cortex-dev-origin` at the internal ALB or at CloudFront.
4. **Check before switching.** `cortex-dev-origin` must resolve to the public ALB. A direct request from an ordinary internet client should time out because the ALB security group accepts only CloudFront origin-facing addresses. The listener's default `403` applies to requests that reach the ALB from an allowed network source but lack the correct verification header. Verify the origin certificate and rejection rule through that allowed path; do not broaden ALB ingress for a laptop check. `https://cortex-dev.solluciopartners.com` must load the app, and its `/api/health` must return `200` (still through the VPC origin).
5. **Phase B (`apiOrigin: "public"`), as its own PR.** Only the distribution's `/api/*` origin changes: HTTPS-only to `cortex-dev-origin`, TLS 1.2, the same 120-second read timeout, request policy and caching rules, plus the secret header. The VPC origin resource stays defined. To roll back, set `private` again.
6. **Acceptance and cleanup.** Verify login, attachments, uploads and citations, API streaming and direct-origin denial on both hostnames. Only after that, retire the internal ALB and the VPC origin in a separately reviewed cleanup.

The origin secret has no automatic rotation, because CloudFront and the ALB rule must change together. Rotating it means a new secret value, then redeploying the application and delivery stacks in one release.

The origin-access secret must stay in approved secret storage/configuration; never put its value in this runbook, PR text, DNS records or public outputs. This phase is not part of the certificate-only stack execution. Existing origin behavior remains as documented in the [guidebook compliance plan](aws-guidebook-compliance-plan.md) until live evidence confirms the transition.
