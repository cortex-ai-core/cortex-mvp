// Offline design verification only. The regular release app is bin/cortex.ts.
import { readFileSync } from 'node:fs';
import { App, BootstraplessSynthesizer, Tags } from 'aws-cdk-lib';
import { configuration } from '../lib/config.js';
import { Foundation } from '../lib/foundation.js';
import { Data } from '../lib/data.js';
import { Operations } from '../lib/operations.js';
import { Runtime } from '../lib/runtime.js';
import { Delivery } from '../lib/delivery.js';
import { publicEdge } from '../lib/edge.js';
import { DnsCertificate, certificateRegions } from '../lib/certificates.js';
import { LogArchive, centralLogs } from '../lib/log-archive.js';

const app = new App();
const config = configuration(app.node.tryGetContext('environment'), process.env.CDK_DEFAULT_ACCOUNT);
// These names are synthesis fixtures, not verification of AZ availability in an account.
app.node.setContext(`availability-zones:account=${config.account}:region=${config.region}`,
  config.multiAz ? ['us-west-2a', 'us-west-2b', 'us-west-2c'] : ['us-west-2a', 'us-west-2b']);
const saved = JSON.parse(readFileSync(new URL(`../environments/${config.name}.json`, import.meta.url), 'utf8'));
const edge = publicEdge(config, config.name === 'dev' ? saved : {
  apiOrigin: saved.apiOrigin,
  dns: { viewerDomain: `${config.name}.example.invalid` },
  certificates: {
    viewer: `arn:aws:acm:us-east-1:${config.account}:certificate/preparation-only`,
  },
});
const env = { account: config.account, region: config.region };
// A synthesizer is stateful and must not be reused across stacks.
const stackProps = () => ({ env, synthesizer: new BootstraplessSynthesizer() });
const foundation = new Foundation(app, `cortex-${config.name}-foundation`, config, stackProps());
const data = new Data(app, `cortex-${config.name}-data`, config, foundation, saved.snapshot,
  [saved.publicOrigin, edge && `https://${edge.viewerDomain}`].filter(Boolean), stackProps());
const image = saved.image || 'preparation-only-api';
const operations = new Operations(app, `cortex-${config.name}-operations`, config, foundation, data, image, stackProps());
const runtime = new Runtime(app, `cortex-${config.name}-application`, config, foundation, data, operations,
  image, saved.parserImage || 'preparation-only-parser', saved.postgrestImage || 'preparation-only-postgrest', { ...stackProps(), edge });
const delivery = new Delivery(app, `cortex-${config.name}-delivery`, data, runtime, { ...stackProps(), edge });
const archive = new LogArchive(app, 'cortex-central-flowlogs', {
  env: { account: centralLogs.account, region: centralLogs.region }, synthesizer: new BootstraplessSynthesizer(),
});
const purposes: ('viewer' | 'origin')[] = edge?.originDomain ? ['viewer', 'origin'] : ['viewer'];
const certificates = edge ? purposes.map(purpose =>
  new DnsCertificate(app, `cortex-${config.name}-${purpose}-certificate`, config.name, purpose,
    purpose === 'viewer' ? edge.viewerDomain : edge.originDomain!, {
      env: { account: config.account, region: certificateRegions[purpose] }, synthesizer: new BootstraplessSynthesizer(),
    })) : [];
for (const stack of [foundation, data, operations, runtime, delivery, archive, ...certificates]) {
  stack.templateOptions.metadata = { CortexPreparationOnly: true, Purpose: 'Offline validation; contains non-deployable fixture inputs.' };
}
Tags.of(app).add('Project', 'Cortex');
Tags.of(app).add('Environment', config.name);
Tags.of(app).add('ManagedBy', 'CloudFormation');
