import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { configuration } from '../lib/config.js';
import { Foundation } from '../lib/foundation.js';
import { Data } from '../lib/data.js';

test('refuses wrong account, region and unknown environment', () => {
  assert.throws(() => configuration('dev', '474711723859'));
  assert.throws(() => configuration('dev', undefined, 'us-east-2'));
  assert.throws(() => configuration('unknown'));
});
test('snapshot database is private and protected against deletion or replacement', () => {
  const app = new App(); const config = configuration('dev'); const env = { account: config.account, region: config.region };
  const foundation = new Foundation(app, 'cortex-dev-foundation', config, { env });
  const data = new Data(app, 'cortex-dev-data', config, foundation, 'migration-snapshot', undefined, { env });
  const template = Template.fromStack(data);
  template.hasResource('AWS::RDS::DBInstance', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: Match.objectLike({ DBSnapshotIdentifier: 'migration-snapshot', PubliclyAccessible: false, DeletionProtection: true, ManageMasterUserPassword: true }) });
  template.hasResourceProperties('AWS::S3::Bucket', { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }, VersioningConfiguration: { Status: 'Enabled' } });
});

test('complete deployment graph synthesizes without a stack cycle and isolates origins', async () => {
  const { Operations }=await import('../lib/operations.js');
  const { Runtime }=await import('../lib/runtime.js');
  const { Delivery }=await import('../lib/delivery.js');
  const app=new App(), config=configuration('dev'), env={account:config.account,region:config.region};
  const foundation=new Foundation(app,'f',config,{env});
  const data=new Data(app,'d',config,foundation,'unchanged-snapshot',undefined,{env});
  const operations=new Operations(app,'o',config,foundation,data,'immutable-tag',{env});
  const runtime=new Runtime(app,'r',config,foundation,data,operations,'immutable-tag','parser-tag','rest-tag',{env});
  const delivery=new Delivery(app,'c',data,runtime,{env});
  assert.doesNotThrow(()=>app.synth());
  const rt=Template.fromStack(runtime);
  rt.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer',{Scheme:'internal'});
  rt.resourceCountIs('AWS::ECS::Service',3);
  for(const service of Object.values(rt.findResources('AWS::ECS::Service')) as any[])assert.equal(service.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp,'DISABLED');
  const dt=Template.fromStack(delivery);
  dt.hasResourceProperties('AWS::CloudFront::Distribution',{DistributionConfig:Match.objectLike({CacheBehaviors:Match.arrayWith([Match.objectLike({PathPattern:'api/*',CachePolicyId:'4135ea2d-6df8-44a3-9df3-4b5a84be39ad'})])})});
});

test('signer uses private application subnets and default group stays a named-control resource',()=>{
 const app=new App(),config=configuration('dev'),env={account:config.account,region:config.region};
 const foundation=new Foundation(app,'sf',config,{env});
 const data=new Data(app,'sd',config,foundation,'fixed-snapshot',undefined,{env});
 const template=Template.fromStack(data);
 template.hasResourceProperties('AWS::Lambda::Function',{FunctionName:'cortex-dev-upload-signer',VpcConfig:Match.objectLike({SubnetIds:data.resolve(foundation.vpc.privateSubnets.map(s=>s.subnetId)),SecurityGroupIds:Match.anyValue()})});
 const ft=Template.fromStack(foundation);
 ft.hasResourceProperties('AWS::EC2::FlowLog',{LogDestination:'arn:aws:s3:::sollucio-vpc-flowlogs-747301449112-us-west-2/vpc-flowlogs',LogDestinationType:'s3',TrafficType:'ALL',DestinationOptions:{FileFormat:'parquet',HiveCompatiblePartitions:false,PerHourPartition:true}});
 ft.hasResourceProperties('Custom::RestrictDefaultGroup',{GroupId:Match.anyValue()});
});

test('central archive rejects wrong account and scopes delivery to the approved workload',async()=>{
 const {LogArchive}=await import('../lib/log-archive.js');
 assert.throws(()=>new LogArchive(new App(),'wrong',{env:{account:'909762691423',region:'us-west-2'}}));
 const stack=new LogArchive(new App(),'central',{env:{account:'747301449112',region:'us-west-2'}});
 const template=Template.fromStack(stack);
 template.hasResource('AWS::S3::Bucket',{DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain',Properties:Match.objectLike({BucketName:'sollucio-vpc-flowlogs-747301449112-us-west-2',BucketEncryption:Match.anyValue()})});
 template.hasResourceProperties('AWS::S3::BucketPolicy',{PolicyDocument:Match.objectLike({Statement:Match.arrayWith([Match.objectLike({Principal:{Service:'delivery.logs.amazonaws.com'},Action:'s3:PutObject',Condition:Match.objectLike({StringEquals:{'aws:SourceAccount':'909762691423','s3:x-amz-acl':'bucket-owner-full-control'}})})])})});
});
