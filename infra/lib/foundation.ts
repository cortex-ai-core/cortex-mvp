import { Stack, Duration, RemovalPolicy, CfnOutput, CfnResource, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { centralLogs } from './log-archive.js';
import type { Configuration } from './config.js';

export class Foundation extends Stack {
  readonly vpc: ec2.Vpc;
  readonly key: kms.Key;
  readonly repositories: Record<string, ecr.Repository> = {};
  constructor(scope: Construct, id: string, config: Configuration, props: StackProps) {
    super(scope, id, props);
    const prefix = `cortex-${config.name}`;
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      restrictDefaultSecurityGroup: false, vpcName: prefix, ipAddresses: ec2.IpAddresses.cidr(config.cidr),
      availabilityZones: config.multiAz ? ['us-west-2a','us-west-2b','us-west-2c'] : ['us-west-2a','us-west-2b'], natGateways: config.multiAz ? 3 : 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'application', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    const defaultGroupRole = new iam.Role(this,'DefaultGroupRole',{roleName:`${prefix}-default-group`,assumedBy:new iam.ServicePrincipal('lambda.amazonaws.com'),managedPolicies:[iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')]});
    defaultGroupRole.addToPolicy(new iam.PolicyStatement({actions:['ec2:DescribeSecurityGroups'],resources:['*']}));
    defaultGroupRole.addToPolicy(new iam.PolicyStatement({actions:['ec2:RevokeSecurityGroupIngress','ec2:RevokeSecurityGroupEgress'],resources:[`arn:aws:ec2:${config.region}:${this.account}:security-group/${this.vpc.vpcDefaultSecurityGroup}`]}));
    const defaultGroup = new lambda.Function(this,'DefaultGroupCleanup',{runtime:lambda.Runtime.PYTHON_3_13,handler:'index.handler',role:defaultGroupRole,timeout:Duration.seconds(60),code:lambda.Code.fromInline(`import boto3,json,urllib.request
def respond(event,context,status):
 body=json.dumps({'Status':status,'Reason':'Default security group restriction','PhysicalResourceId':'cortex-default-group','StackId':event['StackId'],'RequestId':event['RequestId'],'LogicalResourceId':event['LogicalResourceId'],'Data':{}}).encode()
 urllib.request.urlopen(urllib.request.Request(event['ResponseURL'],data=body,method='PUT',headers={'Content-Type':''}),timeout=15).read()
def handler(event,context):
 try:
  if event['RequestType']!='Delete':
   ec2=boto3.client('ec2'); group=event['ResourceProperties']['GroupId']
   sg=ec2.describe_security_groups(GroupIds=[group])['SecurityGroups'][0]
   for key,method in [('IpPermissions',ec2.revoke_security_group_ingress),('IpPermissionsEgress',ec2.revoke_security_group_egress)]:
    if sg[key]:method(GroupId=group,IpPermissions=sg[key])
  respond(event,context,'SUCCESS')
 except Exception:
  respond(event,context,'FAILED')`)});
    new CfnResource(this,'RestrictDefaultGroup',{type:'Custom::RestrictDefaultGroup',properties:{ServiceToken:defaultGroup.functionArn,GroupId:this.vpc.vpcDefaultSecurityGroup}});
    const flowLog = new logs.LogGroup(this, 'FlowLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN });
    this.vpc.addFlowLog('Traffic', { destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLog) });
    this.vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    if(config.name==='dev')new ec2.CfnFlowLog(this,'CentralFlowLogs',{
      resourceId:this.vpc.vpcId,resourceType:'VPC',trafficType:'ALL',maxAggregationInterval:60,
      logDestinationType:'s3',logDestination:`arn:aws:s3:::${centralLogs.bucket}/${centralLogs.prefix}`,
      // CfnFlowLog types this as a raw object, so CloudFormation property casing is required.
      destinationOptions:{FileFormat:'parquet',HiveCompatiblePartitions:false,PerHourPartition:true},
    });
    this.key = new kms.Key(this, 'DataKey', { alias: `alias/${prefix}-data`, enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN });
    for (const name of ['api', 'parser', 'postgrest']) {
      this.repositories[name] = new ecr.Repository(this, `${name}Repository`, {
        repositoryName: `${prefix}-${name}`, imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE, removalPolicy: RemovalPolicy.RETAIN,
        lifecycleRules: [{ maxImageCount: 30 }],
      });
      new CfnOutput(this, `${name}RepositoryUri`, { value: this.repositories[name].repositoryUri });
    }
    const provider = new iam.OidcProviderNative(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'],
    });
    const execution = new iam.Role(this, 'CloudFormationExecution', {
      roleName: `${prefix}-cloudformation`, assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com'),
    });
    execution.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:*', 'ecs:*', 'ecr:*', 'elasticloadbalancing:*', 'logs:*', 'cloudwatch:*', 's3:*', 'sqs:*', 'sns:*', 'events:*', 'rds:*', 'cognito-idp:*', 'secretsmanager:*', 'kms:*', 'lambda:*', 'servicediscovery:*'],
      resources: ['*'], conditions: { StringEquals: { 'aws:RequestedRegion': config.region } },
    }));
    execution.addToPolicy(new iam.PolicyStatement({ actions: ['cloudfront:*'], resources: ['*'] }));
    execution.addToPolicy(new iam.PolicyStatement({actions:['route53:CreateHostedZone','route53:DeleteHostedZone','route53:GetHostedZone','route53:ListHostedZonesByName','route53:AssociateVPCWithHostedZone','route53:DisassociateVPCFromHostedZone','route53:ChangeResourceRecordSets'],resources:['*']}));
    execution.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:CreateRole', 'iam:GetRole', 'iam:DeleteRole', 'iam:TagRole', 'iam:UntagRole', 'iam:UpdateAssumeRolePolicy', 'iam:PutRolePolicy', 'iam:GetRolePolicy', 'iam:DeleteRolePolicy', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:PassRole'],
      resources: [`arn:aws:iam::${this.account}:role/cortex-*`],
    }));
    execution.addToPolicy(new iam.PolicyStatement({ actions: ['iam:CreateServiceLinkedRole'], resources: [`arn:aws:iam::${this.account}:role/aws-service-role/*`], conditions: { StringEquals: { 'iam:AWSServiceName': ['ecs.amazonaws.com', 'elasticloadbalancing.amazonaws.com', 'rds.amazonaws.com', 'vpcorigin.cloudfront.amazonaws.com'] } } }));
    for (const repository of ['cortex-mvp', 'cortex-ui-mvp']) {
      const deployment = new iam.Role(this, `GitHub-${repository}`, {
        roleName: `${prefix}-github-${repository}`, maxSessionDuration: Duration.hours(1),
        assumedBy: new iam.FederatedPrincipal(provider.oidcProviderArn, {
          StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
          StringLike: { 'token.actions.githubusercontent.com:sub': [
            `repo:cortex-ai-core/${repository}:ref:refs/heads/aws-migration`,
            `repo:cortex-ai-core/${repository}:environment:${config.name}`,
          ] },
        }, 'sts:AssumeRoleWithWebIdentity'),
      });
      const backend = repository === 'cortex-mvp';
      deployment.addToPolicy(new iam.PolicyStatement({ actions: backend ? ['cloudformation:Describe*','cloudformation:List*','cloudformation:Get*','cloudformation:CreateChangeSet','cloudformation:ExecuteChangeSet','cloudformation:DeleteChangeSet'] : ['cloudformation:DescribeStacks'], resources:[`arn:aws:cloudformation:${config.region}:${this.account}:stack/cortex-${config.name}-*/*`] }));
      if(backend){
        deployment.addToPolicy(new iam.PolicyStatement({actions:['iam:PassRole'],resources:[execution.roleArn],conditions:{StringEquals:{'iam:PassedToService':'cloudformation.amazonaws.com'}}}));
        deployment.addToPolicy(new iam.PolicyStatement({actions:['ecr:GetAuthorizationToken'],resources:['*']}));
        for(const repo of Object.values(this.repositories))repo.grantPullPush(deployment);
        deployment.addToPolicy(new iam.PolicyStatement({actions:['ecs:RunTask','ecs:DescribeTasks'],resources:[`arn:aws:ecs:${config.region}:${this.account}:task-definition/cortex-${config.name}-database:*`,`arn:aws:ecs:${config.region}:${this.account}:task/cortex-${config.name}/*`]}));
        deployment.addToPolicy(new iam.PolicyStatement({actions:['iam:PassRole'],resources:[`arn:aws:iam::${this.account}:role/cortex-${config.name}-database-operations`,`arn:aws:iam::${this.account}:role/cortex-${config.name}-database-execution`],conditions:{StringEquals:{'iam:PassedToService':'ecs-tasks.amazonaws.com'}}}));
      } else {
        deployment.addToPolicy(new iam.PolicyStatement({actions:['s3:ListBucket','s3:GetBucketLocation'],resources:[`arn:aws:s3:::cortex-web-${config.name}-${this.account}-${config.region}`]}));
        deployment.addToPolicy(new iam.PolicyStatement({actions:['s3:GetObject','s3:PutObject'],resources:[`arn:aws:s3:::cortex-web-${config.name}-${this.account}-${config.region}/*`]}));
        deployment.addToPolicy(new iam.PolicyStatement({actions:['cloudfront:CreateInvalidation','cloudfront:GetDistribution'],resources:[`arn:aws:cloudfront::${this.account}:distribution/*`]}));
      }
      new CfnOutput(this, `${repository}DeploymentRole`, { value: deployment.roleArn });
    }
    new CfnOutput(this, 'CloudFormationRole', { value: execution.roleArn });
    new CfnOutput(this, 'SnapshotEncryptionKey', { value: this.key.keyArn });
    new CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}
