# Guidebook compliance and deployment plan

Updated October 16, 2026 following Sanjay's request for the AWS Build Book v1.3 network pattern, pages 9–11. This records deployed controls and remaining acceptance; pending controls must not be reported as deployed. Target workload is Cortex-Dev **909762691423**, Oregon **us-west-2**. Log Archive is **747301449112** (guidebook page 2). Ohio retirement was completed separately; see [the retirement record](ohio-retirement.md).


**October 19 decision superseding the public-tier rollout below:** Sanjay selected a private ALB behind CloudFront VPC origins for Dev, Test and Prod. The custom Dev viewer domain now resolves and its website/API health return HTTPS 200. The proposed public-origin switch is cancelled. This is an explicit variation from the guidebook's public load-balancer tier, not a claim of exact tier alignment. The existing private HTTP port-80 origin remains; private routing is not end-to-end application TLS. Test/Prod stay undeployed and locked; their templates now use one internal ALB/VPC origin and require no public origin hostname/certificate. Dev's staged public ALB is unused and retained pending separate cleanup. See [the current domain runbook](custom-domain.md). Tom also confirmed Control Tower-owned log groups are excluded from Vanta and must remain untouched; Cortex-owned Prod log groups retain the one-year CDK policy.

## Verified live baseline

Read-only inspection with an STS-verified Cortex-Dev temporary session confirmed:

- Foundation, Data and Operations stacks are UPDATE_COMPLETE. The overnight Foundation correction succeeded.
- VPC vpc-04f119534267186ac is10.10.0.0/16 with six subnets across us-west-2a/b: public10.10.0.0/24 and10.10.1.0/24; application10.10.2.0/24 and10.10.3.0/24; isolated data10.10.4.0/24 and10.10.5.0/24.
- NAT nat-08d93899d70a6186a is available in public subnet subnet-0aa0343c49e52743c. Both application route tables send0.0.0.0/0 to it. Both data route tables have no internet/NAT default route. S3 gateway endpoint routes exist.
- Default security group sg-0439c52bbae3c561b has zero inbound and outbound rules. Named database group accepts5432 from operations and application groups; operations egress allows private database 5432 and internet HTTPS 443.
- RDS cortex-dev-oregon is available, encrypted, publiclyAccessible=false, in isolated data subnets, deletion-protected, with seven-day automated backups. Dev is single-AZ as configured.
- Application stack is healthy. API, parser and ingestion worker each have one running task and zero pending tasks. Live ENIs are in application subnets with no public IP associations. The existing CloudFront distribution now uses the corrected HTTP-only private origin; the obsolete Oregon origin has been removed and Delivery is UPDATE_COMPLETE.
- Flow Logs are ACTIVE/SUCCESS to both the new central Log Archive S3 destination and the retained local Dev CloudWatch copy. Nonempty central Parquet objects have been read with the Log Archive identity.
- Oregon Cognito has 15 enabled users, all FORCE_CHANGE_PASSWORD, and no migration Lambda trigger. No Ohio authentication bridge is present.

The private inspection snapshot is in ignored.local/migration/inspection-20261016.json; it contains configuration evidence, not session credentials. Previously archived database/file comparisons remain unchanged. The cloud continuation and executor were archived after preserving their handoff and offline CDK context fix locally.

## 1. Central VPC Flow Logs

Implement a direct additional VPC Flow Log delivery to a private S3 destination in Log Archive 747301449112, us-west-2. Keep the existing successful local flow log during rollout so there is no logging gap. A local troubleshooting copy can coexist with the authoritative central archive.

First inspect the existing Log Archive logging resources with authorized access. Reuse an approved destination only after its owner confirms prefix, retention and policy ownership. Otherwise propose a dedicated VPC Flow Logs bucket managed by a separate central-logging CDK/CloudFormation stack; do not replace Control Tower's CloudTrail/Config buckets or overwrite their policies.

Destination configuration: block public access, enforceTLS, encryption and retention according to the archive policy, with explicit log-delivery permissions for approved workload account/Region prefixes. Restrict delivery.logs.amazonaws.com using source-account and source-ARN conditions; grant only required ACL inspection/write operations for delivery. SSE-S3 supports cross-account delivery. If the owner requires SSE-KMS, use a customer-managed key ARN with the required delivery-service key policy; the AWS-managed aws/s3 KMS key cannot support this cross-account path. The book's stated 365 days applies to CloudTrail; confirm the VPC Flow Logs retention separately.

The source stack accepts a reviewed destination ARN/prefix as configuration, validates it belongs to the expected central design, and creates a distinct central Flow Log resource without replacing the VPC, NAT or local log group. Test/Prod can use separate account prefixes after their own access/bootstrap; do not deploy those accounts now.

Acceptance: live source FlowLog ACTIVE and DeliverLogsStatus SUCCESS; generate known Dev network traffic, then verify fresh account/Region-tagged log objects in the central bucket and read them with an authorized Log Archive identity. A source-side green status alone is insufficient evidence. Preserve policy/change-set review and delivery evidence.

Access resolved: a separate STS-verified Log Archive session was supplied. A dedicated retained, encrypted, private bucket has been provisioned by the new cortex-central-flowlogs stack in account747301449112. Control Tower-owned resources were not modified. Dev central FlowLog fl-0110297a2ed5a0a17 is ACTIVE/SUCCESS and a nonempty Parquet object has arrived in the correct source-account/Region prefix. The first inspected Parquet file contains17 records for the correct Dev account, including6 accepted traffic records with statusOK. Two initial records reportSKIPDATA. A later batch contains70 records, including30OK,37NODATA and3SKIPDATA. Delivery is working, but Flow Logs must not be represented as lossless; continue monitoring skipped-record rates.

## 2. Upload-signing Lambda in private application subnets

Live verification complete: Data stack UPDATE_COMPLETE; Lambda Active/Successful in both application subnets with named group sg-05cfbb96f105a5e86. Synthetic60-byte SigV4HTTPS upload returned200 and HeadObject matched its SHA256/size. Its exact synthetic object version was removed after verification.

Attach the upload signer to both private application subnets with its own named security group, no inbound rules and only necessary outbound HTTPS 443. Add the Lambda ENI execution permissions required for the VPC attachment; keep the API task as the only intended invocation principal and keep the S3 put permission scoped to original-object paths. No public function URL is introduced.

Use the existing S3 gateway endpoint for S3 API requests from the VPC. NAT provides other approved outboundHTTPS; no database access is needed by the signer. Configure explicit SigV4 presigning. Preserve the current API request/response contract, five-minute URL expiry, size/type/SHA256 binding and namespace authorization. Treat the infrastructure cleanup Lambda separately as a control-plane utility; do not imply that managed services themselves occupy workload subnets.

Acceptance: deployed Lambda VpcConfig references only application subnets and its named group; invoke it through the authenticated API, upload a synthetic file using the returned URL, confirm stored size/checksum, and complete ingestion. Verify an unauthorized invocation/upload remains rejected. Check timeout/error behavior and log output for absence of credentials/passwords.

## 3. Default security group

Already verified live: inbound=[] and outbound=[]. Keep the IaC default-group restriction resource and named-group design. Include this check in post-deployment verification and future environment bootstrap. It is a completed control requiring regression confirmation, not an outstanding hardening mutation.

Acceptance: EC2 DescribeSecurityGroups still reports both rule arrays empty after Foundation/Application deployment. All Cortex task/database/Lambda interfaces reference their named groups.

## 4. Historical public-tier rollout — superseded by the private-origin decision

Revise the interim Application/Delivery design to match the guidebook: internet-facing ALB across both public subnets, API/worker/parser Fargate tasks in private application subnets with assignPublicIp=DISABLED, and RDS remaining isolated. Public subnet placement is for the load balancer/NAT; it does not make the API tasks or database public.

CloudFront remains the user entry point. Replace the private VPC-origin configuration with the reviewed public-ALB origin. Restrict ALB security-group ingress to HTTPS 443 from the AWS-managed CloudFront origin-facing prefix list. Configure the listener to forward only requests with a deployment-generated secret origin header; default action rejects other requests. Store/generate the header secret through AWS secret references, never source control or user-visible config. Allow ALB-to-API 8081 through named groups. Do not open the API or PostgREST directly to the internet.

RequireHTTPS from CloudFront to the ALB using an ACM certificate inus-west-2 and an origin hostname in a DNS zone the organization controls. Do not use an invalid/self-signed certificate or silently downgrade this public hop to HTTP. The AWS-generated ALB hostname cannot be used to obtain an organization-owned ACM certificate. The user-facing URL can remain the AWS-generated CloudFront HTTPS address; only the backend origin requires organization DNS. A future custom CloudFront viewer domain uses its own certificate requirements separately.

Acceptance: live ALB Scheme=internet-facing and its subnets are public; HTTPS listener/certificate are valid; ingress is restricted to the CloudFront managed prefix list; direct untrusted ALB requests cannot reach the application, and requests lacking the origin header receive the configured rejection. CloudFront/API health and streaming chat work over the public origin with caching disabled for authenticatedAPI. ECS ENIs have no public IPs and live service subnet IDs are application-tier only. Verify RDS remains private and unchanged.

Sanjay has now supplied the GoDaddy-managed solluciopartners.com zone and confirmed cortex-dev.solluciopartners.com for viewers and cortex-dev-origin.solluciopartners.com for the origin. The existing Vercel hostname has no custom DNS to migrate. Separate CDK certificate stacks request the required CloudFront certificate in us-east-1 and ALB certificate in us-west-2; the former is the CloudFront service-required exception, not a workload deployment outside Oregon. Exact GoDaddy validation records are returned by ACM; the staged routing procedure is in [custom-domain.md](custom-domain.md). Until certificate validation and the separately reviewed origin transition complete, retain the existing private ALB and CloudFront VPC origin as an open guidebook deviation. Do not claim this control is implemented before that input exists. The signer change is deployed and verified. The public ALB remains pending; current code retains the private ALB/VPC origin. The interim private hop explicitly uses HTTP port80 to match its listener, and the ALB ingress uses the AWS-owned CloudFront origin-facing prefix list; the viewer connection remains HTTPS. Changing to a public origin requires validated HTTPS first.

## 5. Historical rollout order — superseded where it calls for a public origin

1. Verify the supplied Log Archive session and review the new dedicated destination stack/policies. Hostname/zone input is resolved; external certificate validation and public-HTTPS-origin acceptance are pending. Preserve the working private origin during those steps.
2. Implement and locally validate the revised topology plus the preserved offline CDK context fix. Test full synthesis without AWS lookups, account/Region guards, stateful retention/replacement guards, signer/ALB placement, secret references, central log destination and security-group rules. Inspect CloudFormation change sets; do not replace RDS/buckets/pools/keys.
3. Apply approved Log Archive destination changes, then Dev Foundation/Data changes. Verify central log delivery, default-group rules and private signer behavior.
4. Resume backend GitHub Actions: build immutable ARM64 API image, apply Data/Operations, run the private database migration task, deploy Application and Delivery, check service stability and live networking. Foundation/bootstrap changes remain explicitly reviewed operations.
5. Publish the static UI through its own GitHub Actions workflow. Add the generated HTTPS viewer origin to document bucketCORS, then test browser uploads.
6. Exercise first-login password change/reset with an authorized test identity, roles/namespaces, restored history, old file viewing, citations, upload-to-SQS-to-Docling-to-ready, persistence and failure/DLQ recovery. Record successful push deployment runs for both repositories; a PR-only build is not a deployment.
7. Compare implemented controls with the remaining book requirements, including central logging evidence, approved deployment access, runtime monitoring/backup arrangements and operational alerts. Do not report network alignment as overall regulatory or SOC2 certification.
8. Hand Oregon to Sanjay for personal acceptance. Keep Ohio running until Sanjay explicitly performs the separate retirement runbook after write cutoff/final reconciliation. There is no ongoing Ohio-to-Oregon data replication and no automated Ohio deletion.

Published/source references: AWS VPC NAT gateways, cross-account centralized Flow Logs, CloudFront ALB origin restrictions/HTTPS, and Lambda VPC configuration. Shared brain skills were used as guidance; no work-specific knowledge was exported to global skills.
