# New Oregon Dev hostname and GoDaddy DNS

Owner: SolluCIO Cortex-Dev account **909762691423**. Workloads remain in **us-west-2**. DNS for `solluciopartners.com` stays in GoDaddy; no Route53 hosted zone or nameserver migration is needed.

Sanjay confirmed these new hostnames:

| Purpose | Hostname | Destination after acceptance |
|---|---|---|
| User-facing application | `cortex-dev.solluciopartners.com` | Existing CloudFront distribution |
| Legacy public origin | `cortex-dev-origin.solluciopartners.com` | Existing unused public ALB; not the selected API route |

The existing UI is on `cortex-ui-mvp.vercel.app` without an organization custom domain. This is a new AWS endpoint, not a DNS cutover from Vercel. Existing Vercel and generated CloudFront access remain available during acceptance. Ohio retirement was completed separately; see the [retirement record](ohio-retirement.md).

**October 19 architecture decision:** Sanjay selected CloudFront VPC origins with a private ALB for Dev, Test and Prod. The public-origin switch is cancelled. Both GoDaddy routing CNAMEs resolve, and the custom viewer hostname and `/api/health` return HTTPS 200 through the existing private path. The Dev public ALB remains provisioned but unused; removal is a separate reviewed cleanup, not part of the Test/Prod configuration change.

## 1. Certificates and private-origin requirements

[certificates.ts](../infra/lib/certificates.ts) defines separate retained, DNS-validated, nonexportable ACM certificate stacks containing no workload, Route53 or IAM resources:

- `cortex-dev-viewer-certificate` in **us-east-1** for CloudFront.
- `cortex-dev-origin-certificate` in **us-west-2** for the previously staged public ALB. This existing certificate remains attached; private-only Test/Prod do not need an origin hostname/certificate.

The viewer certificate is the required CloudFront service exception to the Oregon workload rule. No application, database, parser or file storage moves to us-east-1. See [CloudFront certificate-region requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html).

Dev's names are in `infra/environments/dev.json` under `dns`; the top-level `apiOrigin: private` selects the private path. The viewer alias, certificate and CORS are already configured. The certificate app remains separate from normal release synthesis/deployment.

From the backend root, synthesize without credentials/lookups:

```bash
npm ci --prefix infra
CDK_DEFAULT_ACCOUNT=909762691423 \
AWS_EC2_METADATA_DISABLED=true \
npm run synth:certificates --prefix infra -- \
  -c environment=dev --no-lookups --quiet
```

For a private Test/Prod API, use the generated CloudFront address or supply only `viewerDomain` and a viewer certificate for a custom hostname. `synth:certificates` accepts viewer-only input and produces only the us-east-1 certificate stack. An origin hostname/certificate is required only for an explicitly selected public API origin. The app rejects the wrong account, service region, wildcard, URL or malformed hostname.

Certificate bootstrap uses a separately authenticated Cortex-Dev administrator/approved certificate provisioning identity. The normal workload CloudFormation role does not currently grant ACM provisioning permissions, and the existing `apply-stack.mjs` helper assumes that role and Oregon. Do not silently broaden that role or change its region guard to bootstrap these independent certificate stacks.

Before creating each stack, verify STS account909762691423, validate its synthesized template in the corresponding region and review a CREATE change set. The expected change is exactly one Add of `AWS::CertificateManager::Certificate`. Execute that reviewed change set without waiting for stack completion. Reuse an existing matching request if present; do not create duplicate certificates or replace a certificate attached to a live endpoint.

## 2. Add the exact ACM validation CNAMEs in GoDaddy

While each stack is creating, use CloudFormation `list-stack-resources` to find its certificate physical ARN, then ACM `describe-certificate` in that certificate's region. Copy `DomainValidationOptions[].ResourceRecord` exactly. Do not invent the underscore-prefixed tokens.

In GoDaddy's `solluciopartners.com` zone, create **CNAME** records. The **Name/Host** field is the ACM record name with `.solluciopartners.com.` removed; **Value/Target** is the full ACM validation target. Preserve leading underscores. Use the default TTL (or600seconds if available). Do not append the zone twice or add URL schemes/paths.

Keep the validation records after issuance so ACM can renew the certificates. Validation records authorize certificate issuance; they do not route user traffic. Domain CAA restrictions, if introduced later, must allow the issuing Amazon CA.

With external DNS, `CREATE_IN_PROGRESS` and ACM `PENDING_VALIDATION` are expected until the CNAMEs resolve and ACM issues the certificate. This is not a failed application deployment. See [ACM DNS validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html) and [CloudFormation external-validation behavior](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-certificatemanager-certificate.html).

## 3. Selected routing: keep the private ALB

Every environment now explicitly selects top-level `apiOrigin: "private"`. Older nested `dns.apiOrigin` inputs remain readable for compatibility, but conflicting controls fail synthesis.

The request path is:

```text
Browser -- HTTPS --> CloudFront -- VPC origin --> internal ALB -- HTTP 8081 --> private API task
```

The current ALB/VPC-origin hop uses HTTP port 80 over the private VPC-origin connection. This is network privacy, not end-to-end application TLS. If a production control requires TLS on that hop, plan a versioned HTTPS private-origin rollout separately; do not claim this configuration already provides it. RDS connections already use TLS. See [CloudFront VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html).

- Keep the existing private ALB, its listener/target group, security groups and VPC origin resource identities.
- API caching stays disabled; the public viewer remains HTTPS.
- Test/Prod desired state has one internal ALB and one VPC origin. Application tasks have no public IPs. Their deployment gates stay disabled.
- A custom viewer alias requires a us-east-1 certificate and GoDaddy CNAME to its CloudFront distribution. It does not require a public origin ALB or an additional origin DNS record.
- Dev's generated and custom CloudFront addresses remain usable. The `cortex-dev-origin` record is not used by the selected API behavior.

## 4. Historical public-ALB staging and cleanup boundary

The earlier guidebook implementation added an internet-facing HTTPS ALB, an Oregon certificate, a secret origin header and an origin DNS record. The public ALB accepts only CloudFront prefix-list traffic and forwards only requests with the secret header. It was staged alongside the internal ALB, but live traffic was never switched to it.

Sanjay's October 19 decision supersedes that Phase B plan. Keeping the private ALB is an explicit variation from the guidebook's public load-balancer tier; do not report exact public-tier alignment or execute the old public-origin transition.

Existing Dev public-origin settings/certificate are retained in source so this configuration PR does not unexpectedly delete deployed resources. New Test/Prod private configurations do not provision a public ALB, even if old public-origin metadata is present. Removing the unused Dev public ALB/listener/target group and obsolete origin settings is a separate reviewed operation after inspecting live dependencies. Do not delete the working private ALB/VPC origin.

Keep ACM validation records while certificates remain provisioned. Do not remove live DNS records, certificates or the origin secret as a side effect of changing the environment templates.
