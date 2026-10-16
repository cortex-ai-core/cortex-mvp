import { certificateRegions, dnsHostname, type CertificatePurpose } from './certificates.js';
import type { Configuration } from './config.js';

// CloudFront adds this header to every request it sends to the public origin ALB.
// The ALB forwards only requests carrying the generated value and rejects the rest.
export const originHeader = 'X-Cortex-Origin-Verify';
export const originSecretName = (environment: string) => `cortex-${environment}/cloudfront-origin`;

export type PublicEdge = {
  viewerDomain: string; originDomain: string;
  viewerCertificateArn: string; originCertificateArn: string;
  // private: /api/* stays on the VPC origin. public: /api/* uses originDomain over HTTPS.
  // Switch to public only after originDomain resolves to the public ALB (docs/custom-domain.md).
  apiOrigin: 'private' | 'public';
  originSecretName: string;
};

// Environments without a dns block keep only the generated CloudFront hostname.
export function publicEdge(config: Configuration, saved: { dns?: any; certificates?: any }): PublicEdge | undefined {
  const { dns, certificates } = saved;
  if (!dns && !certificates) return undefined;
  const viewerDomain = dnsHostname(dns?.viewerDomain ?? ''), originDomain = dnsHostname(dns?.originDomain ?? '');
  if (viewerDomain === originDomain) throw new Error('Viewer and origin hostnames must differ.');
  if (dns.apiOrigin !== 'private' && dns.apiOrigin !== 'public') throw new Error('Set dns.apiOrigin to "private" or "public" explicitly.');
  const certificate = (purpose: CertificatePurpose) => {
    const arn = certificates?.[purpose], expected = `arn:aws:acm:${certificateRegions[purpose]}:${config.account}:certificate/`;
    if (typeof arn !== 'string' || !arn.startsWith(expected)) throw new Error(`Supply the ${purpose} certificate ARN from ${certificateRegions[purpose]} in account ${config.account}.`);
    return arn;
  };
  return { viewerDomain, originDomain, viewerCertificateArn: certificate('viewer'), originCertificateArn: certificate('origin'), apiOrigin: dns.apiOrigin, originSecretName: originSecretName(config.name) };
}
