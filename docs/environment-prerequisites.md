# Environment prerequisites

Updated October 23, 2026. **Test is enabled on the `test` branch; Prod remains disabled.** The authoritative current Test resource inventory, exact artifact-promotion contract, DNS records, acceptance and rollback steps are in [the README](../README.md#test-environment-and-dev-to-test-promotion).

## Current Test release path

- Account `223323955607`, Oregon `us-west-2`, VPC `10.20.0.0/16`, two AZs, one NAT, Single-AZ RDS with seven-day backups and 30-day managed CloudWatch retention.
- A push to `test` selects a successful Dev AWS release, copies exact API/parser/PostgREST digests and deploys all five Test workload stacks. No container rebuild or application-data transfer occurs during promotion.
- GitHub source/target roles trust the exact backend Test branch. The Dev reader has ECR read-only permissions; it cannot change Dev workloads. Test remains account-isolated.
- The private ALB/VPC-origin design is selected. A custom browser hostname requires only its us-east-1 viewer certificate. While DNS validation is pending, releases use the generated CloudFront address and activate the alias after certificate issuance.
- The initial database is schema-only, all 25 application tables are empty, and Cognito has no users. Provisioning a Test tenant/admin is a separate task.
- Central Log Archive delivery is account-scoped and active. The October 23 policy operation added Test without adding Prod.
- No budget definitions or alarm subscriptions were returned by Dev inventory; Test preserves that configuration and the same service sizes.

## Offline preparation remains non-deployable

`npm run prepare:environments` verifies all environment designs without an AWS session. Outputs under `.local/preparation/` carry `Metadata.CortexPreparationOnly` and include fixture domains/certificates. Never deploy them or remove their marker. Use `infra/bin/cortex.ts` and the standard release helper for real Test deployment.

## Production prerequisites remain outstanding

Prod account `474711723859` remains locked in both repositories. No Prod resources, datasets, identities or releases are authorized by the Test request. Before a separate Prod rollout:

1. Obtain scoped AWS access and explicit provisioning authorization; review SCPs/quotas and organization ownership. Preserve Control Tower-owned resources.
2. Agree reviewed source/release approval rules and repository protections with an owner/admin. Require successful Test acceptance for the same artifacts.
3. Review Prod availability, scale, cost, WAF/transport policy, secrets and the approved data source. Defaults are three AZs/three NATs, Multi-AZ RDS, 35-day backups and one-year managed workload-log retention.
4. Prepare independent identities/data and environment-specific secrets; do not implicitly copy Dev/Test data.
5. Review Log Archive source permissions, central log delivery, alert recipients, backup/restore, RPO/RTO and restore evidence.
6. Review DNS/viewer certificates, CloudFront/private-origin configuration and browser-origin CORS.
7. Protect source/rollback artifacts from expiry and verify deployment/recovery before enabling either repository's Prod gate.

The current Test branch-driven promotion does not itself establish production approval or readiness. See [runtime and recovery](runtime-and-recovery.md) and [log retention](log-retention.md).
