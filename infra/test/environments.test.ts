import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { configuration } from '../lib/config.js';
import { Foundation } from '../lib/foundation.js';
import { Data } from '../lib/data.js';
import { LogArchive, centralLogs } from '../lib/log-archive.js';
import { Operations } from '../lib/operations.js';
import { Runtime } from '../lib/runtime.js';
import { Delivery } from '../lib/delivery.js';
import { publicEdge } from '../lib/edge.js';

for (const environment of ['dev', 'test', 'prod']) {
  test(`${environment} foundation uses isolated tiers, central logging and deployment trust bound to the release source`, () => {
    const app = new App(), config = configuration(environment);
    const props = { env: { account: config.account, region: config.region } };
    const foundation = new Foundation(app, 'foundation', config, props);
    const template = Template.fromStack(foundation);
    template.resourceCountIs('AWS::EC2::Subnet', environment === 'prod' ? 9 : 6);
    template.resourceCountIs('AWS::EC2::NatGateway', environment === 'prod' ? 3 : 1);
    const flows = Object.values(template.findResources('AWS::EC2::FlowLog'));
    assert.ok(flows.some(flow => flow.Properties?.LogDestinationType === 's3'
      && flow.Properties.LogDestination === `arn:aws:s3:::${centralLogs.bucket}/${centralLogs.prefix}`));
    const roles = Object.values(template.findResources('AWS::IAM::Role'));
    const deploymentRoles = roles.filter(role => typeof role.Properties.RoleName === 'string' && role.Properties.RoleName.includes('-github-'));
    assert.equal(deploymentRoles.length, 2);
    for (const role of deploymentRoles) {
      const statements = role.Properties.AssumeRolePolicyDocument.Statement;
      assert.equal(statements.length, 1);
      const condition = statements[0].Condition;
      assert.equal(condition.StringEquals['token.actions.githubusercontent.com:aud'], 'sts.amazonaws.com');
      const repository = role.Properties.RoleName.endsWith('cortex-ui-mvp') ? 'cortex-ui-mvp' : 'cortex-mvp';
      assert.equal(condition.StringEquals['token.actions.githubusercontent.com:sub'],
        environment === 'test' ? `repo:cortex-ai-core/${repository}:ref:refs/heads/test` : `repo:cortex-ai-core/${repository}:environment:${environment}`);
      assert.ok(!JSON.stringify(condition).includes('ref:refs/heads/dev'));
    }
    if(environment==='test') {
      const statements=Object.values(template.findResources('AWS::IAM::Policy')).flatMap(policy=>policy.Properties.PolicyDocument.Statement);
      const verification=statements.find(statement=>statement.Action==='ecr:DescribeImages');
      assert.ok(verification,'Test promotion must verify destination digests');
      assert.equal(verification.Resource.length,3,'Digest reads must be scoped to the three Test repositories');
    }

  });
}

for (const environment of ['test', 'prod']) {
  test(`${environment} configuration uses one private ALB with a VPC origin and preserves the explicit deployment gate`, () => {
    const app = new App(), config = configuration(environment);
    const props = { env: { account: config.account, region: config.region } };
    const foundation = new Foundation(app, 'foundation', config, props);
    const data = new Data(app, 'data', config, foundation, undefined, [], props);
    const saved = JSON.parse(readFileSync(new URL(`../environments/${environment}.json`, import.meta.url), 'utf8'));
    assert.equal(saved.deploymentEnabled, environment === 'test');
    assert.equal(saved.apiOrigin, 'private');
    const edge = publicEdge(config, {
      apiOrigin: saved.apiOrigin,
      // Even leftover public-origin metadata must not override private selection.
      dns: { viewerDomain: `${environment}.example.invalid`, originDomain: `${environment}-origin.example.invalid` },
      certificates: {
        viewer: `arn:aws:acm:us-east-1:${config.account}:certificate/test-only`,
        origin: `arn:aws:acm:us-west-2:${config.account}:certificate/test-only`,
      },
    });
    const operations = new Operations(app, 'operations', config, foundation, data, 'api-image', props);
    const runtime = new Runtime(app, 'application', config, foundation, data, operations, 'api-image', 'parser-image', 'rest-image', { ...props, edge });
    const delivery = new Delivery(app, 'delivery', data, runtime, { ...props, edge });
    const rt = Template.fromStack(runtime), dt = Template.fromStack(delivery);
    const database = Object.values(Template.fromStack(data).findResources('AWS::RDS::DBInstance'))[0];
    assert.equal(database.Properties.DBSnapshotIdentifier, undefined);
    assert.equal(database.Properties.PubliclyAccessible, false);
    assert.equal(database.Properties.MultiAZ, environment === 'prod');
    assert.equal(database.Properties.BackupRetentionPeriod, environment === 'prod' ? 35 : 7);
    rt.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    rt.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internal' });
    dt.resourceCountIs('AWS::CloudFront::VpcOrigin', 1);
    dt.hasResourceProperties('AWS::CloudFront::VpcOrigin', { VpcOriginEndpointConfig: { HTTPPort: 80, OriginProtocolPolicy: 'http-only' } });
    for (const service of Object.values(rt.findResources('AWS::ECS::Service'))) {
      assert.equal(service.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp, 'DISABLED');
    }
    const api = Object.values(rt.findResources('AWS::ECS::Service')).find(service => service.Properties.ServiceName === `cortex-${environment}-api`)!;
    assert.equal(api.Properties.DesiredCount, environment === 'prod' ? 2 : 1);
    assert.equal(api.Properties.LoadBalancers.length, 1);
    assert.ok(!JSON.stringify([rt.toJSON(), dt.toJSON()]).includes('909762691423'), 'New runtime/delivery must not reference the Dev account');
  });
}

test('central archive grants delivery to each exact account prefix without broad source trust', () => {
  const template = Template.fromStack(new LogArchive(new App(), 'logs', {
    env: { account: centralLogs.account, region: centralLogs.region },
  }));
  const policy = Object.values(template.findResources('AWS::S3::BucketPolicy'))[0].Properties.PolicyDocument;
  const writes = policy.Statement.filter((statement: any) => statement.Action === 's3:PutObject');
  assert.equal(writes.length, 3);
  for (const environment of ['dev', 'test', 'prod']) {
    const { account } = configuration(environment);
    const write = writes.find((statement: any) => statement.Condition.StringEquals['aws:SourceAccount'] === account);
    assert.ok(write, `Missing ${environment} delivery permission`);
    assert.equal(write.Condition.ArnLike['aws:SourceArn'], `arn:aws:logs:us-west-2:${account}:*`);
    assert.match(JSON.stringify(write.Resource), new RegExp(`vpc-flowlogs/AWSLogs/${account}/\\*`));
  }
});
