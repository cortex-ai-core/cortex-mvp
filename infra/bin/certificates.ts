import { App, BootstraplessSynthesizer } from 'aws-cdk-lib';
import { readFileSync } from 'node:fs';
import { configuration } from '../lib/config.js';
import { DnsCertificate, certificateRegions, dnsHostname } from '../lib/certificates.js';

const app = new App();
const config = configuration(app.node.tryGetContext('environment') || 'dev', process.env.CDK_DEFAULT_ACCOUNT);
const saved = JSON.parse(readFileSync(new URL(`../environments/${config.name}.json`, import.meta.url), 'utf8'));
const viewer = app.node.tryGetContext('viewerDomain') || saved.dns?.viewerDomain;
const origin = app.node.tryGetContext('originDomain') || saved.dns?.originDomain;
if (typeof viewer !== 'string' || typeof origin !== 'string' || dnsHostname(viewer) === dnsHostname(origin)) {
  throw new Error('Supply distinct viewerDomain and originDomain context values.');
}
for (const [purpose, hostname] of [['viewer', viewer], ['origin', origin]] as const) {
  new DnsCertificate(app, `cortex-${config.name}-${purpose}-certificate`, config.name, purpose, hostname, {
    env: { account: config.account, region: certificateRegions[purpose] },
    synthesizer: new BootstraplessSynthesizer(),
  });
}
