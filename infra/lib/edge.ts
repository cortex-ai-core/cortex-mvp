import { certificateRegions, dnsHostname, type CertificatePurpose } from './certificates.js';
import type { Configuration } from './config.js';

// CloudFront adds this header to every request it sends to the public origin ALB.
// The ALB forwards only requests carrying the generated value and rejects the rest.
export const originHeader = 'X-Cortex-Origin-Verify';
export const originSecretName = (environment: string) => `cortex-${environment}/cloudfront-origin`;

export type PublicEdge = {
  viewerDomain: string; originDomain?: string;
  viewerCertificateArn: string; originCertificateArn?: string;
  // private: /api/* stays on the VPC origin. public: /api/* uses originDomain over HTTPS.
  // Switch to public only after originDomain resolves to the public ALB (docs/custom-domain.md).
  apiOrigin: 'private' | 'public';
  originSecretName: string;
};

// Environments without a dns block keep only the generated CloudFront hostname.
export function publicEdge(config: Configuration, saved: { apiOrigin?: unknown; dns?: any; certificates?: any }): PublicEdge | undefined {
  const { dns, certificates } = saved;
  // Read the legacy nested field for older configuration, but never let two
  // conflicting controls select different origins during a rollout.
  if (saved.apiOrigin !== undefined && dns?.apiOrigin !== undefined && saved.apiOrigin !== dns.apiOrigin) {
    throw new Error('Conflicting apiOrigin settings. Use the top-level environment field.');
  }
  const apiOrigin = saved.apiOrigin !== undefined ? saved.apiOrigin : dns?.apiOrigin ?? (!dns && !certificates ? 'private' : undefined);
  if (apiOrigin !== 'private' && apiOrigin !== 'public') throw new Error('Set apiOrigin to "private" or "public" explicitly.');
  if (!dns && !certificates) {
    if (apiOrigin === 'public') throw new Error('A public API origin requires DNS and certificates.');
    return undefined;
  }
  const viewerDomain = dnsHostname(dns?.viewerDomain ?? '');
  const certificate = (purpose: CertificatePurpose) => {
    const arn = certificates?.[purpose], expected = `arn:aws:acm:${certificateRegions[purpose]}:${config.account}:certificate/`;
    if (typeof arn !== 'string' || !arn.startsWith(expected)) throw new Error(`Supply the ${purpose} certificate ARN from ${certificateRegions[purpose]} in account ${config.account}.`);
    return arn;
  };
  const originConfigured = dns?.originDomain !== undefined || certificates?.origin !== undefined;
  if (apiOrigin === 'public' && !originConfigured) throw new Error('A public API origin requires an origin hostname and certificate.');
  const originDomain = originConfigured ? dnsHostname(dns?.originDomain ?? '') : undefined;
  if (viewerDomain === originDomain) throw new Error('Viewer and origin hostnames must differ.');
  return { viewerDomain, originDomain, viewerCertificateArn: certificate('viewer'),
    originCertificateArn: originConfigured ? certificate('origin') : undefined,
    apiOrigin, originSecretName: originSecretName(config.name) };
}
