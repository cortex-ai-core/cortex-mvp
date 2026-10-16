import { Stack, Duration, RemovalPolicy, CfnOutput, CfnDeletionPolicy, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { readFileSync } from 'node:fs';
import type { Configuration } from './config.js';
import type { Foundation } from './foundation.js';
import { originSecretName } from './edge.js';

export class Data extends Stack {
  readonly database: rds.CfnDBInstance;
  readonly databaseGroup: ec2.SecurityGroup;
  readonly documents: s3.Bucket;
  readonly web: s3.Bucket;
  readonly pool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  readonly runtimeSecret: secrets.Secret;
  readonly restSecret: secrets.Secret;
  readonly parserSecret: secrets.Secret;
  readonly databaseSecret: secrets.Secret;
  readonly openaiSecret: secrets.Secret;
  readonly archives: s3.Bucket;
  readonly legacySecret: secrets.Secret;
  readonly originSecret: secrets.Secret;
  readonly uploadSigner: lambda.Function;
  constructor(scope: Construct, id: string, config: Configuration, foundation: Foundation, snapshot: string | undefined, publicOrigins: string[] = [], props: StackProps) {
    super(scope, id, props);
    const prefix = `cortex-${config.name}`;
    this.databaseGroup = new ec2.SecurityGroup(this, 'DatabaseAccess', { vpc: foundation.vpc, description: 'Only approved Cortex tasks can reach PostgreSQL', allowAllOutbound: false });
    const subnet = new rds.CfnDBSubnetGroup(this, 'DatabaseSubnets', { dbSubnetGroupDescription: `${prefix} isolated database subnets`, subnetIds: foundation.vpc.isolatedSubnets.map(s => s.subnetId) });
    const parameters = new rds.CfnDBParameterGroup(this, 'Parameters', { description: `${prefix} PostgreSQL TLS`, family: 'postgres18', parameters: { 'rds.force_ssl': '1' } });
    this.database = new rds.CfnDBInstance(this, 'Database', {
      dbInstanceIdentifier: `${prefix}-oregon`, engine: 'postgres', engineVersion: '18.3',
      dbInstanceClass: config.multiAz ? 'db.t4g.medium' : 'db.t4g.micro',
      ...(snapshot ? { dbSnapshotIdentifier: snapshot } : { masterUsername: 'postgres', dbName: 'cortex', storageEncrypted: true, kmsKeyId: foundation.key.keyArn }),
      manageMasterUserPassword: true, allocatedStorage: '20', maxAllocatedStorage: 100, storageType: 'gp3',
      dbSubnetGroupName: subnet.ref, vpcSecurityGroups: [this.databaseGroup.securityGroupId],
      dbParameterGroupName: parameters.ref, publiclyAccessible: false, multiAz: config.multiAz,
      backupRetentionPeriod: config.multiAz ? 35 : 7, deletionProtection: true,
      copyTagsToSnapshot: true, deleteAutomatedBackups: false, enableCloudwatchLogsExports: ['postgresql', 'upgrade'],
    });
    this.database.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;
    this.database.cfnOptions.updateReplacePolicy = CfnDeletionPolicy.RETAIN;
    this.databaseSecret = new secrets.Secret(this, 'DatabaseLogin', { secretName: `${prefix}/database`, generateSecretString: { secretStringTemplate: JSON.stringify({ username: 'cortex_postgrest' }), generateStringKey: 'password', passwordLength: 48, excludePunctuation: true } });
    this.runtimeSecret = new secrets.Secret(this, 'RuntimeSigning', { secretName: `${prefix}/runtime`, generateSecretString: { passwordLength: 64, excludePunctuation: true } });
    this.restSecret = new secrets.Secret(this, 'DatabaseSigning', { secretName: `${prefix}/postgrest-signing`, generateSecretString: { passwordLength: 64, excludePunctuation: true } });
    this.parserSecret = new secrets.Secret(this, 'ParserSigning', { secretName: `${prefix}/parser-signing`, generateSecretString: { passwordLength: 64, excludePunctuation: true } });
    this.openaiSecret = new secrets.Secret(this, 'OpenAi', { secretName: `${prefix}/openai` });
    this.legacySecret = new secrets.Secret(this, 'LegacyCognito', { secretName: `${prefix}/legacy-cognito` });
    // Shared by CloudFront and the public origin ALB through CloudFormation dynamic references.
    // Do not enable automatic rotation: both resources must be redeployed together with a new value.
    this.originSecret = new secrets.Secret(this, 'CloudFrontOrigin', { secretName: originSecretName(config.name), generateSecretString: { passwordLength: 64, excludePunctuation: true } });
    for (const secret of [this.databaseSecret, this.runtimeSecret, this.restSecret, this.parserSecret, this.openaiSecret, this.legacySecret, this.originSecret]) secret.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.archives = new s3.Bucket(this, 'MigrationArchive', {
      bucketName: `cortex-migration-${config.name}-${this.account}-${config.region}`,
      versioned: true, encryption: s3.BucketEncryption.KMS, encryptionKey: foundation.key,
      enforceSSL: true, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, removalPolicy: RemovalPolicy.RETAIN,
    });
    this.documents = new s3.Bucket(this, 'Documents', {
      bucketName: `cortex-documents-${config.name}-${this.account}-${config.region}`,
      versioned: true, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true, eventBridgeEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN, lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(7) }],
      cors: [{ allowedOrigins: ['http://localhost:3002', ...publicOrigins], allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD, s3.HttpMethods.PUT], allowedHeaders: ['*'], exposedHeaders: ['ETag'], maxAge: 3600 }],
    });
    this.web = new s3.Bucket(this, 'Web', {
      bucketName: `cortex-web-${config.name}-${this.account}-${config.region}`,
      versioned: true, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, removalPolicy: RemovalPolicy.RETAIN,
    });
    // The web assets are public through CloudFront. Account-scoped OAC access avoids
    // a data-stack -> distribution -> application -> data-stack dependency cycle.
    this.web.addToResourcePolicy(new iam.PolicyStatement({ principals:[new iam.ServicePrincipal('cloudfront.amazonaws.com')], actions:['s3:GetObject'], resources:[this.web.arnForObjects('*')], conditions:{StringEquals:{'AWS:SourceAccount':this.account},ArnLike:{'AWS:SourceArn':`arn:aws:cloudfront::${this.account}:distribution/*`}} }));
    this.pool = new cognito.UserPool(this, 'Users', {
      userPoolName: prefix, selfSignUpEnabled: false, signInAliases: { email: true }, signInCaseSensitive: false,
      autoVerify: { email: true }, standardAttributes: { email: { required: true, mutable: true } },
      customAttributes: { legacy_subject: new cognito.StringAttribute({ mutable: false }), legacy_issuer: new cognito.StringAttribute({ mutable: false }) },
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      removalPolicy: RemovalPolicy.RETAIN, deletionProtection: true,
    });
    this.client = this.pool.addClient('Backend', { generateSecret: true, authFlows: { userPassword: true }, preventUserExistenceErrors: true });
    const uploadRole = new iam.Role(this,'UploadRole',{roleName:`${prefix}-upload-signer`,assumedBy:new iam.ServicePrincipal('lambda.amazonaws.com'),managedPolicies:[iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')]});
    const signerGroup=new ec2.SecurityGroup(this,'UploadSignerAccess',{vpc:foundation.vpc,allowAllOutbound:false,description:'Private upload signer HTTPS egress only'});
    signerGroup.addEgressRule(ec2.Peer.anyIpv4(),ec2.Port.tcp(443),'S3 and approved AWS HTTPS');
    uploadRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'));
    this.uploadSigner = new lambda.Function(this,'UploadSigner',{
      functionName:`${prefix}-upload-signer`,runtime:lambda.Runtime.PYTHON_3_13,handler:'index.handler',role:uploadRole,
      code:lambda.Code.fromInline(readFileSync(new URL('../lambda/presign.py',import.meta.url),'utf8')),timeout:Duration.seconds(10),
      environment:{DOCUMENTS_BUCKET:this.documents.bucketName},vpc:foundation.vpc,
      vpcSubnets:{subnetType:ec2.SubnetType.PRIVATE_WITH_EGRESS},securityGroups:[signerGroup],
    });
    this.documents.grantPut(uploadRole,'*/original.*');
    for (const [key, value] of Object.entries({ DatabaseHost: this.database.attrEndpointAddress, DatabaseAdminSecret: this.database.attrMasterUserSecretSecretArn, DatabaseSecret: this.databaseSecret.secretArn, RuntimeSecret: this.runtimeSecret.secretArn, OpenAiSecret: this.openaiSecret.secretArn, LegacySecret: this.legacySecret.secretArn, MigrationBucket: this.archives.bucketName, DocumentsBucket: this.documents.bucketName, WebBucket: this.web.bucketName, UserPoolId: this.pool.userPoolId, UserPoolClientId: this.client.userPoolClientId })) new CfnOutput(this, key, { value });
  }
}
