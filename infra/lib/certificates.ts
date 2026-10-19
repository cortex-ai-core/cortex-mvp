import { Stack, CfnOutput, RemovalPolicy, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { configuration } from './config.js';

export type CertificatePurpose = 'viewer' | 'origin';
export const certificateRegions = { viewer: 'us-east-1', origin: 'us-west-2' } as const;

export function dnsHostname(value: string): string {
  const hostname = value.trim().toLowerCase();
  const labels = hostname.split('.');
  if (hostname.length > 253 || labels.length < 2 || labels.some(label =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('Supply an explicit DNS hostname without a scheme, path or wildcard.');
  }
  return hostname;
}

export function certificateRequests(viewer: unknown, origin: unknown, requiresOrigin = false): { purpose: CertificatePurpose; hostname: string }[] {
  if (typeof viewer !== 'string') throw new Error('Supply a viewerDomain hostname.');
  const viewerName = dnsHostname(viewer);
  const requests: { purpose: CertificatePurpose; hostname: string }[] = [{ purpose: 'viewer', hostname: viewerName }];
  if (origin !== undefined) {
    if (typeof origin !== 'string') throw new Error('Supply a valid originDomain hostname.');
    const originName = dnsHostname(origin);
    if (originName === viewerName) throw new Error('Viewer and origin hostnames must differ.');
    requests.push({ purpose: 'origin', hostname: originName });
  } else if (requiresOrigin) throw new Error('A public API requires an originDomain hostname.');
  return requests;
}

// Separate stacks allow GoDaddy validation to wait without blocking updates to
// the running application. CloudFront requires its viewer certificate in us-east-1;
// only this certificate is outside the Oregon workload region.
export class DnsCertificate extends Stack {
  constructor(scope: Construct, id: string, environment: string, purpose: CertificatePurpose, hostname: string, props: StackProps) {
    const config = configuration(environment, props.env?.account);
    if (props.env?.account !== config.account) throw new Error('Explicit certificate account required.');
    if (props.env?.region !== certificateRegions[purpose]) throw new Error('Unexpected certificate region.');
    super(scope, id, { ...props, analyticsReporting: false });
    const domain = dnsHostname(hostname);
    const certificate = new acm.CfnCertificate(this, 'Certificate', {
      domainName: domain,
      validationMethod: 'DNS',
      keyAlgorithm: 'RSA_2048',
      certificateExport: 'DISABLED',
      tags: [
        { key: 'Project', value: 'Cortex' },
        { key: 'Environment', value: config.name },
        { key: 'Purpose', value: purpose },
        { key: 'ManagedBy', value: 'CloudFormation' },
      ],
    });
    certificate.applyRemovalPolicy(RemovalPolicy.RETAIN);
    new CfnOutput(this, 'CertificateArn', { value: certificate.ref });
    new CfnOutput(this, 'Hostname', { value: domain });
  }
}
