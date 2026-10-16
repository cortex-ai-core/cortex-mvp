import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { configuration } from '../lib/config.js';
import { publicEdge, originHeader } from '../lib/edge.js';

const config = configuration('dev');
const dns = { viewerDomain: 'viewer.example.invalid', originDomain: 'origin.example.invalid' };
const certificates = {
  viewer: 'arn:aws:acm:us-east-1:909762691423:certificate/viewer',
  origin: 'arn:aws:acm:us-west-2:909762691423:certificate/origin',
};

test('edge input requires distinct hostnames, an explicit API origin and same-account certificates in their service regions', () => {
  assert.equal(publicEdge(config, {}), undefined);
  assert.throws(() => publicEdge(config, { dns: { ...dns }, certificates }), /apiOrigin/);
  assert.throws(() => publicEdge(config, { dns: { ...dns, apiOrigin: 'private', originDomain: dns.viewerDomain }, certificates }));
  assert.throws(() => publicEdge(config, { dns: { ...dns, apiOrigin: 'private' } }), /viewer certificate/);
  assert.throws(() => publicEdge(config, { dns: { ...dns, apiOrigin: 'private' }, certificates: { ...certificates, viewer: certificates.viewer.replace('us-east-1', 'us-west-2') } }));
  assert.throws(() => publicEdge(config, { dns: { ...dns, apiOrigin: 'private' }, certificates: { ...certificates, origin: certificates.origin.replace('909762691423', '474711723859') } }));
  assert.equal(publicEdge(config, { dns: { ...dns, apiOrigin: 'public' }, certificates })?.originSecretName, 'cortex-dev/cloudfront-origin');
});

async function synth(apiOrigin: 'private' | 'public') {
  const { Foundation } = await import('../lib/foundation.js');
  const { Data } = await import('../lib/data.js');
  const { Operations } = await import('../lib/operations.js');
  const { Runtime } = await import('../lib/runtime.js');
  const { Delivery } = await import('../lib/delivery.js');
  const edge = publicEdge(config, { dns: { ...dns, apiOrigin }, certificates })!;
  const app = new App(), env = { account: config.account, region: config.region };
  const foundation = new Foundation(app, 'f', config, { env });
  const data = new Data(app, 'd', config, foundation, 'unchanged-snapshot', [`https://${edge.viewerDomain}`], { env });
  const operations = new Operations(app, 'o', config, foundation, data, 'immutable-tag', { env });
  const runtime = new Runtime(app, 'r', config, foundation, data, operations, 'immutable-tag', 'parser-tag', 'rest-tag', { env, edge });
  const delivery = new Delivery(app, 'c', data, runtime, { env, edge });
  assert.doesNotThrow(() => app.synth());
  return { foundation: Template.fromStack(foundation), data: Template.fromStack(data), runtime: Template.fromStack(runtime), delivery: Template.fromStack(delivery) };
}

test('public origin ALB accepts only CloudFront over HTTPS and forwards only requests with the origin secret', async () => {
  const { runtime, data, foundation } = await synth('private');
  runtime.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 2);
  runtime.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internal' });
  runtime.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internet-facing', LoadBalancerAttributes: Match.arrayWith([{ Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' }]) });
  runtime.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Port: 443, Protocol: 'HTTPS', SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06', Certificates: [{ CertificateArn: certificates.origin }], DefaultActions: [Match.objectLike({ Type: 'fixed-response', FixedResponseConfig: Match.objectLike({ StatusCode: '403' }) })] });
  runtime.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', { Priority: 1, Conditions: [{ Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: originHeader, Values: ['{{resolve:secretsmanager:cortex-dev/cloudfront-origin:SecretString:::}}'] } }] });
  runtime.hasResourceProperties('AWS::EC2::SecurityGroupIngress', { FromPort: 443, ToPort: 443, IpProtocol: 'tcp', SourcePrefixListId: 'pl-82a045eb' });
  const groups = Object.values(runtime.findResources('AWS::EC2::SecurityGroup')) as any[];
  for (const group of groups) for (const rule of group.Properties.SecurityGroupIngress ?? []) assert.notEqual(rule.CidrIp, '0.0.0.0/0', 'No security group is open to the internet');
  const api = Object.values(runtime.findResources('AWS::ECS::Service')).find((s: any) => s.Properties.ServiceName === 'cortex-dev-api') as any;
  assert.equal(api.Properties.LoadBalancers.length, 2, 'API tasks register with the private and public ALBs');
  assert.equal(api.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp, 'DISABLED');
  data.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'cortex-dev/cloudfront-origin' });
  data.hasResourceProperties('AWS::S3::Bucket', { CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedOrigins: ['http://localhost:3002', 'https://viewer.example.invalid'] })] } });
  foundation.hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'acm:DescribeCertificate' })]) } });
});

test('private phase adds the viewer alias but keeps /api/* on the VPC origin', async () => {
  const { delivery } = await synth('private');
  delivery.hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: Match.objectLike({
    Aliases: ['viewer.example.invalid'],
    ViewerCertificate: { AcmCertificateArn: certificates.viewer, MinimumProtocolVersion: 'TLSv1.2_2021', SslSupportMethod: 'sni-only' },
    Origins: Match.arrayWith([Match.objectLike({ VpcOriginConfig: Match.anyValue() })]),
  }) });
  const distribution = Object.values(delivery.findResources('AWS::CloudFront::Distribution'))[0] as any;
  assert.ok(!distribution.Properties.DistributionConfig.Origins.some((o: any) => o.DomainName === 'origin.example.invalid'));
});

test('public phase sends /api/* to the HTTPS origin hostname with the secret header and keeps the VPC origin resource', async () => {
  const { delivery } = await synth('public');
  delivery.resourceCountIs('AWS::CloudFront::VpcOrigin', 1);
  delivery.hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: Match.objectLike({
    Origins: Match.arrayWith([Match.objectLike({
      DomainName: 'origin.example.invalid',
      CustomOriginConfig: Match.objectLike({ OriginProtocolPolicy: 'https-only', OriginSSLProtocols: ['TLSv1.2'], OriginReadTimeout: 120 }),
      OriginCustomHeaders: [{ HeaderName: originHeader, HeaderValue: '{{resolve:secretsmanager:cortex-dev/cloudfront-origin:SecretString:::}}' }],
    })]),
  }) });
});
