import { Stack, Duration, RemovalPolicy, CfnOutput, SecretValue, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as discovery from 'aws-cdk-lib/aws-servicediscovery';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type { Configuration } from './config.js';
import type { Foundation } from './foundation.js';
import type { Data } from './data.js';
import type { Operations } from './operations.js';
import { originHeader, type PublicEdge } from './edge.js';

export class Runtime extends Stack {
  readonly alb?: elb.ApplicationLoadBalancer;
  readonly publicAlb?: elb.ApplicationLoadBalancer;
  readonly queue: sqs.Queue;
  constructor(scope: Construct, id: string, config: Configuration, foundation: Foundation, data: Data, operations: Operations, image: string, parserImage: string, postgrestImage: string, props: StackProps & { edge?: PublicEdge }) {
    super(scope, id, props);
    const prefix=`cortex-${config.name}`;
    const taskGroup=new ec2.SecurityGroup(this,'ApplicationAccess',{vpc:foundation.vpc,allowAllOutbound:false});
    taskGroup.addEgressRule(ec2.Peer.anyIpv4(),ec2.Port.tcp(443),'AWS and OpenAI HTTPS');
    taskGroup.addEgressRule(data.databaseGroup,ec2.Port.tcp(5432),'Private PostgreSQL TLS');
    data.databaseGroup.addIngressRule(taskGroup,ec2.Port.tcp(5432),'Application database access',true);
    const parserGroup=new ec2.SecurityGroup(this,'ParserAccess',{vpc:foundation.vpc,allowAllOutbound:false});
    parserGroup.addIngressRule(taskGroup,ec2.Port.tcp(8090),'Only application and ingestion tasks');
    parserGroup.addEgressRule(ec2.Peer.anyIpv4(),ec2.Port.tcp(443),'Image pull and logs');
    taskGroup.addEgressRule(parserGroup,ec2.Port.tcp(8090),'Private Docling');
    const namespace=new discovery.PrivateDnsNamespace(this,'Discovery',{name:`${prefix}.internal`,vpc:foundation.vpc});
    const dead=new sqs.Queue(this,'DeadLetters',{queueName:`${prefix}-ingestion-dead`,encryption:sqs.QueueEncryption.SQS_MANAGED,retentionPeriod:Duration.days(14)});
    this.queue=new sqs.Queue(this,'Queue',{queueName:`${prefix}-ingestion`,encryption:sqs.QueueEncryption.SQS_MANAGED,visibilityTimeout:Duration.minutes(15),retentionPeriod:Duration.days(4),deadLetterQueue:{queue:dead,maxReceiveCount:5}});
    new events.Rule(this,'OriginalUploads',{eventPattern:{source:['aws.s3'],detailType:['Object Created'],detail:{bucket:{name:[data.documents.bucketName]},object:{key:[{wildcard:'*/original.*'}]}}},targets:[new targets.SqsQueue(this.queue)]});
    this.queue.addToResourcePolicy(new iam.PolicyStatement({principals:[new iam.ServicePrincipal('s3.amazonaws.com')],actions:['sqs:SendMessage'],resources:[this.queue.queueArn],conditions:{ArnEquals:{'aws:SourceArn':data.documents.bucketArn},StringEquals:{'aws:SourceAccount':config.account}}}));
    const topic=new sns.Topic(this,'Alerts',{topicName:`${prefix}-operations`});
    for(const [name,metric,threshold] of [
      ['DeadLetters',dead.metricApproximateNumberOfMessagesVisible(),1],
      ['QueueAge',this.queue.metricApproximateAgeOfOldestMessage(),900],
    ] as const){
      const alarm=new cloudwatch.Alarm(this,`${name}Alarm`,{metric,threshold,evaluationPeriods:1,treatMissingData:cloudwatch.TreatMissingData.NOT_BREACHING});
      alarm.addAlarmAction(new actions.SnsAction(topic));
    }
    const executionRole=new iam.Role(this,'ExecutionRole',{roleName:`${prefix}-application-execution`,assumedBy:new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),managedPolicies:[iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')]});
    const taskRole=new iam.Role(this,'ApplicationRole',{roleName:`${prefix}-application`,assumedBy:new iam.ServicePrincipal('ecs-tasks.amazonaws.com')});
    data.documents.grantReadWrite(taskRole);
    this.queue.grantSendMessages(taskRole);
    this.queue.grantConsumeMessages(taskRole);
    data.uploadSigner.grantInvoke(taskRole);
    taskRole.addToPolicy(new iam.PolicyStatement({actions:['cognito-idp:DescribeUserPoolClient','cognito-idp:AdminCreateUser','cognito-idp:AdminSetUserPassword','cognito-idp:AdminDeleteUser'],resources:[data.pool.userPoolArn]}));
    const environment={AWS_REGION:config.region,CORTEX_ACCOUNT_ID:config.account,BACKEND_PROVIDER:'aws',PORT:'8081',RDS_REST_URL:'http://127.0.0.1:3001',COGNITO_USER_POOL_ID:data.pool.userPoolId,COGNITO_CLIENT_ID:data.client.userPoolClientId,S3_DOCUMENTS_BUCKET:data.documents.bucketName,UPLOAD_SIGNER_NAME:data.uploadSigner.functionName,PARSER_URL:`http://parser.${prefix}.internal:8090`,INGEST_QUEUE_URL:this.queue.queueUrl,INGEST_WORKER:'off',RETENTION_SWEEP_MINUTES:'0',COGNITO_LEGACY_ISSUER:config.name==='dev'?'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_gfKKl0wNa':''};
    const apiSecrets={AWS_CORTEX_JWT_SECRET:ecs.Secret.fromSecretsManager(data.runtimeSecret),RDS_REST_JWT_SECRET:ecs.Secret.fromSecretsManager(data.restSecret),PARSER_SECRET:ecs.Secret.fromSecretsManager(data.parserSecret),OPENAI_API_KEY:ecs.Secret.fromSecretsManager(data.openaiSecret)};
    const log=(name:string)=>ecs.LogDrivers.awsLogs({logGroup:new logs.LogGroup(this,`${name}Logs`,{logGroupName:`/cortex/${config.name}/${name}`,retention:config.logRetentionDays,removalPolicy:RemovalPolicy.RETAIN}),streamPrefix:name});
    const createTask=(name:string,command?:string[])=>{
      const task=new ecs.FargateTaskDefinition(this,`${name}Task`,{family:`${prefix}-${name}`,cpu:512,memoryLimitMiB:1024,executionRole,taskRole,runtimePlatform:{cpuArchitecture:ecs.CpuArchitecture.ARM64,operatingSystemFamily:ecs.OperatingSystemFamily.LINUX}});
      task.applyRemovalPolicy(RemovalPolicy.RETAIN);
      const rest=task.addContainer('postgrest',{image:ecs.ContainerImage.fromEcrRepository(foundation.repositories.postgrest,postgrestImage),memoryReservationMiB:128,environment:{CORTEX_DB_HOST:data.database.attrEndpointAddress,PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:'3001',PGRST_DB_SCHEMAS:'public',PGRST_DB_EXTRA_SEARCH_PATH:'extensions',PGRST_DB_CONFIG:'false',PGRST_DB_POOL:'5',PGRST_JWT_AUD:'cortex:database',PGRST_JWT_ROLE_CLAIM_KEY:'$.role',PGRST_OPENAPI_MODE:'disabled',PGRST_LOG_LEVEL:'error'},secrets:{CORTEX_DB_PASSWORD:ecs.Secret.fromSecretsManager(data.databaseSecret,'password'),PGRST_JWT_SECRET:ecs.Secret.fromSecretsManager(data.restSecret)},logging:log(`${name}-postgrest`),readonlyRootFilesystem:true,linuxParameters:new ecs.LinuxParameters(this,`${name}RestLinux`,{initProcessEnabled:true})});
      const container=task.addContainer(name,{image:ecs.ContainerImage.fromEcrRepository(foundation.repositories.api,image),environment,secrets:apiSecrets,logging:log(name),...(command?{command}:{}),portMappings:command?[]:[{containerPort:8081}],linuxParameters:new ecs.LinuxParameters(this,`${name}Linux`,{initProcessEnabled:true})});
      task.defaultContainer=container;
      container.addContainerDependencies({container:rest,condition:ecs.ContainerDependencyCondition.START});
      return {task,container};
    };
    const parserRole=new iam.Role(this,'ParserRole',{roleName:`${prefix}-parser`,assumedBy:new iam.ServicePrincipal('ecs-tasks.amazonaws.com')});
    const parserTask=new ecs.FargateTaskDefinition(this,'ParserTask',{family:`${prefix}-parser`,cpu:2048,memoryLimitMiB:4096,executionRole,taskRole:parserRole,runtimePlatform:{cpuArchitecture:ecs.CpuArchitecture.ARM64,operatingSystemFamily:ecs.OperatingSystemFamily.LINUX}});
    parserTask.addContainer('parser',{image:ecs.ContainerImage.fromEcrRepository(foundation.repositories.parser,parserImage),secrets:{PARSER_SECRET:ecs.Secret.fromSecretsManager(data.parserSecret)},logging:log('parser'),portMappings:[{containerPort:8090}],healthCheck:{command:['CMD-SHELL','curl -fsS http://localhost:8090/health || exit 1'],startPeriod:Duration.seconds(120),interval:Duration.seconds(30),timeout:Duration.seconds(5)}});
    new ecs.FargateService(this,'Parser',{serviceName:`${prefix}-parser`,cluster:operations.cluster,taskDefinition:parserTask,securityGroups:[parserGroup],vpcSubnets:{subnetType:ec2.SubnetType.PRIVATE_WITH_EGRESS},desiredCount:1,minHealthyPercent:100,maxHealthyPercent:200,circuitBreaker:{rollback:true},cloudMapOptions:{cloudMapNamespace:namespace,name:'parser'}});
    const api=createTask('api');
    const service=new ecs.FargateService(this,'Api',{serviceName:`${prefix}-api`,cluster:operations.cluster,taskDefinition:api.task,securityGroups:[taskGroup],vpcSubnets:{subnetType:ec2.SubnetType.PRIVATE_WITH_EGRESS},desiredCount:config.multiAz?2:1,minHealthyPercent:100,maxHealthyPercent:200,circuitBreaker:{rollback:true},healthCheckGracePeriod:Duration.seconds(90)});
    const worker=createTask('worker',['node','scripts/aws/start-worker.mjs']);
    new ecs.FargateService(this,'Worker',{serviceName:`${prefix}-worker`,cluster:operations.cluster,taskDefinition:worker.task,securityGroups:[taskGroup],vpcSubnets:{subnetType:ec2.SubnetType.PRIVATE_WITH_EGRESS},desiredCount:1,minHealthyPercent:100,maxHealthyPercent:200,circuitBreaker:{rollback:true}});
    // Preserve Dev's staged origin and rollback identity. Fresh Test/Prod environments
    // with a public HTTPS origin do not need a second ALB or a VPC origin.
    if(config.name==='dev'||props.edge?.apiOrigin!=='public'){
      const albGroup=new ec2.SecurityGroup(this,'OriginAccess',{vpc:foundation.vpc,allowAllOutbound:false});
      albGroup.addIngressRule(ec2.Peer.prefixList(config.cloudFrontOriginFacingPrefixListId),ec2.Port.tcp(80),'CloudFront origin-facing service only');
      albGroup.addEgressRule(taskGroup,ec2.Port.tcp(8081),'API tasks');
      taskGroup.addIngressRule(albGroup,ec2.Port.tcp(8081),'Private ALB only');
      this.alb=new elb.ApplicationLoadBalancer(this,'LoadBalancer',{vpc:foundation.vpc,internetFacing:false,securityGroup:albGroup,vpcSubnets:{subnetType:ec2.SubnetType.PRIVATE_WITH_EGRESS},idleTimeout:Duration.seconds(120)});
      this.alb.addListener('Http',{port:80,open:false}).addTargets('Api',{port:8081,protocol:elb.ApplicationProtocol.HTTP,targets:[service],healthCheck:{path:'/api/health',healthyHttpCodes:'200'},deregistrationDelay:Duration.seconds(30)});
    }
    // Private origins need only a viewer certificate. Preserve Dev's previously
    // provisioned public ALB until separately reviewed cleanup, not in new accounts.
    if(props.edge?.originDomain&&props.edge.originCertificateArn&&(props.edge.apiOrigin==='public'||config.name==='dev')){
      // Public HTTPS origin for CloudFront (docs/custom-domain.md). Only CloudFront's origin-facing
      // ranges reach port 443, and only requests carrying the origin secret are forwarded to the API.
      const publicGroup=new ec2.SecurityGroup(this,'PublicOriginAccess',{vpc:foundation.vpc,allowAllOutbound:false});
      publicGroup.addIngressRule(ec2.Peer.prefixList(config.cloudFrontOriginFacingPrefixListId),ec2.Port.tcp(443),'CloudFront origin-facing service only');
      publicGroup.addEgressRule(taskGroup,ec2.Port.tcp(8081),'API tasks');
      taskGroup.addIngressRule(publicGroup,ec2.Port.tcp(8081),'Public origin ALB only');
      this.publicAlb=new elb.ApplicationLoadBalancer(this,'PublicLoadBalancer',{vpc:foundation.vpc,internetFacing:true,securityGroup:publicGroup,vpcSubnets:{subnetType:ec2.SubnetType.PUBLIC},idleTimeout:Duration.seconds(120),dropInvalidHeaderFields:true});
      const https=this.publicAlb.addListener('Https',{port:443,protocol:elb.ApplicationProtocol.HTTPS,open:false,sslPolicy:elb.SslPolicy.RECOMMENDED_TLS,certificates:[elb.ListenerCertificate.fromArn(props.edge.originCertificateArn)],defaultAction:elb.ListenerAction.fixedResponse(403,{contentType:'text/plain',messageBody:'Forbidden'})});
      https.addTargets('PublicApi',{priority:1,conditions:[elb.ListenerCondition.httpHeader(originHeader,[SecretValue.secretsManager(props.edge.originSecretName).unsafeUnwrap()])],port:8081,protocol:elb.ApplicationProtocol.HTTP,targets:[service],healthCheck:{path:'/api/health',healthyHttpCodes:'200'},deregistrationDelay:Duration.seconds(30)});
      // GoDaddy CNAME target for props.edge.originDomain.
      new CfnOutput(this,'PublicOriginDns',{value:this.publicAlb.loadBalancerDnsName});
    }
    for(const [key,value] of Object.entries({IngestionQueue:this.queue.queueUrl,IngestionQueueArn:this.queue.queueArn,DeadLetterQueue:dead.queueUrl,AlertsTopic:topic.topicArn,ApiService:service.serviceName,ApiTask:api.task.taskDefinitionArn})) new CfnOutput(this,key,{value});
  }
}
