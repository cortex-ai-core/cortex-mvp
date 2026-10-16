#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { App, Tags, BootstraplessSynthesizer } from 'aws-cdk-lib';
import { configuration } from '../lib/config.js';
import { Foundation } from '../lib/foundation.js';
import { Data } from '../lib/data.js';
import { Operations } from '../lib/operations.js';
import { Runtime } from '../lib/runtime.js';
import { Delivery } from '../lib/delivery.js';

const app = new App();
const config = configuration(app.node.tryGetContext('environment') || 'dev', process.env.CDK_DEFAULT_ACCOUNT, process.env.CDK_DEFAULT_REGION || 'us-west-2');
const env = { account: config.account, region: config.region };
const foundation = new Foundation(app, `cortex-${config.name}-foundation`, config, { env, synthesizer: new BootstraplessSynthesizer() });
const saved = JSON.parse(readFileSync(new URL(`../environments/${config.name}.json`, import.meta.url),'utf8'));
const snapshot = app.node.tryGetContext('snapshot') || saved.snapshot;
const input = (name:string) => app.node.tryGetContext(name) || saved[name];
if (app.node.tryGetContext('includeData') === 'true') {
  const data = new Data(app, `cortex-${config.name}-data`, config, foundation, snapshot, input('publicOrigin'), { env, synthesizer: new BootstraplessSynthesizer() });
  const image = input('image');
  if (image) {
    const operations = new Operations(app, `cortex-${config.name}-operations`, config, foundation, data, image, { env, synthesizer: new BootstraplessSynthesizer() });
    if (app.node.tryGetContext('includeRuntime') === 'true') {
      const runtime = new Runtime(app, `cortex-${config.name}-application`, config, foundation, data, operations, image, input('parserImage') || image, input('postgrestImage') || image, { env, synthesizer: new BootstraplessSynthesizer() });
      new Delivery(app, `cortex-${config.name}-delivery`, data, runtime, { env, synthesizer: new BootstraplessSynthesizer() });
    }
  }
}
Tags.of(app).add('Project', 'Cortex');
Tags.of(app).add('Environment', config.name);
Tags.of(app).add('ManagedBy', 'CloudFormation');
