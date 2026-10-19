import { Stack, CfnOutput, RemovalPolicy, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import type { Configuration } from './config.js';
import type { Foundation } from './foundation.js';
import type { Data } from './data.js';

export class Operations extends Stack {
  readonly cluster: ecs.Cluster;
  readonly group: ec2.SecurityGroup;
  readonly migration: ecs.FargateTaskDefinition;
  constructor(scope: Construct, id: string, config: Configuration, foundation: Foundation, data: Data, image: string, props: StackProps) {
    super(scope, id, props);
    const prefix = `cortex-${config.name}`;
    this.cluster = new ecs.Cluster(this, 'Cluster', { clusterName: prefix, vpc: foundation.vpc, enableFargateCapacityProviders: true });
    this.group = new ec2.SecurityGroup(this, 'OperationsAccess', { vpc: foundation.vpc, allowAllOutbound: false });
    this.group.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'AWS APIs via NAT');
    this.group.addEgressRule(data.databaseGroup, ec2.Port.tcp(5432), 'Private PostgreSQL');
    data.databaseGroup.addIngressRule(this.group, ec2.Port.tcp(5432), 'Controlled database operations', true);
    const role = new iam.Role(this, 'TaskRole', { roleName: `${prefix}-database-operations`, assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
    data.archives.grantReadWrite(role);
    data.documents.grantRead(role);
    const executionRole = new iam.Role(this, 'ExecutionRole', { roleName: `${prefix}-database-execution`, assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'), managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')] });
    this.migration = new ecs.FargateTaskDefinition(this, 'DatabaseTask', {
      family: `${prefix}-database`, cpu: 512, memoryLimitMiB: 1024, taskRole: role, executionRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    const admin = secrets.Secret.fromSecretCompleteArn(this, 'AdminCredentials', data.database.attrMasterUserSecretSecretArn);
    this.migration.addContainer('database', {
      image: ecs.ContainerImage.fromEcrRepository(foundation.repositories.api, image),
      command: ['node', 'scripts/aws/database-task.mjs'],
      environment: { AWS_REGION: config.region, CORTEX_ACCOUNT_ID: config.account, PGHOST: data.database.attrEndpointAddress, PGDATABASE: 'cortex', PGSSLMODE: 'verify-full', PGSSLROOTCERT: '/app/rds-ca.pem', MIGRATION_BUCKET: data.archives.bucketName },
      secrets: { PGUSER: ecs.Secret.fromSecretsManager(admin, 'username'), PGPASSWORD: ecs.Secret.fromSecretsManager(admin, 'password'), CORTEX_DB_PASSWORD: ecs.Secret.fromSecretsManager(data.databaseSecret, 'password') },
      logging: ecs.LogDrivers.awsLogs({ logGroup: new logs.LogGroup(this, 'DatabaseLogs', { logGroupName: `/cortex/${config.name}/database`, retention: config.logRetentionDays, removalPolicy: RemovalPolicy.RETAIN }), streamPrefix: 'database' }),
    });
    for (const [key,value] of Object.entries({ Cluster: this.cluster.clusterName, DatabaseTask: this.migration.taskDefinitionArn, TaskSecurityGroup: this.group.securityGroupId, PrivateSubnets: foundation.vpc.privateSubnets.map(s=>s.subnetId).join(',') })) new CfnOutput(this,`${key}Output`,{value}).overrideLogicalId(key);
  }
}
