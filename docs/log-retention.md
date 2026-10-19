# CloudWatch retention

Owner: SolluCIO Cortex infrastructure. Prod account: `474711723859`, region: `us-west-2`.

Tom's Vanta retention requirement is at least 365 days for every Prod log group. `configuration()` in `infra/lib/config.ts` supplies `RetentionDays.ONE_YEAR` for Prod and preserves `RetentionDays.ONE_MONTH` for Dev/Test.

| Stack | CloudWatch log groups | Prod retention |
| --- | --- | --- |
| Foundation | Generated `cortex-prod-foundation` VPC flow-log group | 365 days |
| Operations | `/cortex/prod/database` | 365 days |
| Application | `/cortex/prod/api`, `/cortex/prod/api-postgrest` | 365 days |
| Application | `/cortex/prod/worker`, `/cortex/prod/worker-postgrest`, `/cortex/prod/parser` | 365 days |

All seven managed groups retain their existing CloudFormation `Retain` deletion/replacement policies. Log retention controls the age of events; `Retain` controls whether CloudFormation deletes a group when its stack/resource is removed.

Lambda default log groups (upload signer and default-security-group cleanup) and RDS-export log groups are created by their AWS services and currently have no expiry configured. This satisfies the requested "365 days or never expire" policy. If these groups are later managed explicitly, apply the same Prod retention floor. CloudWatch's no-expiry setting is an omitted `RetentionInDays`; do not replace it with a shorter period. See [AWS log-group retention](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-logs-loggroup.html).

The central S3 flow-log archive has its own 365-day lifecycle. This change covers the CloudWatch destination and does not extend the central archive's current Dev-only delivery policy to Prod.

## Verification and rollout

`infra/test/log-retention.test.ts` synthesizes the complete Dev, Test and Prod graphs. It checks all managed groups, verifies that VPC flow logs are included, and guards the Prod retention floor and existing Dev/Test settings. Run `npm run build --prefix infra` and `npm test --prefix infra`.

These are template settings, not evidence of a live Prod deployment. Prod still needs its own bootstrap and release prerequisites. Foundation must be applied separately through the reviewed infrastructure process; normal releases apply Data, Operations, Application and Delivery only. After Prod deployment, inventory **all** CloudWatch groups, including Lambda and RDS groups created by AWS. Every group must report `retentionInDays >= 365`, or omit it for never-expiring logs:

```bash
aws sts get-caller-identity --profile YOUR_CORTEX_PROD_PROFILE
aws logs describe-log-groups --profile YOUR_CORTEX_PROD_PROFILE --region us-west-2 \
  --query 'logGroups[].{name:logGroupName,retentionDays:retentionInDays}'
```

Stop if STS does not return account `474711723859`. Increasing retention does not recover events already deleted under an earlier policy.
