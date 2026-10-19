import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { configuration } from '../lib/config.js';
import { Foundation } from '../lib/foundation.js';
import { Data } from '../lib/data.js';
import { Operations } from '../lib/operations.js';
import { Runtime } from '../lib/runtime.js';
import { Delivery } from '../lib/delivery.js';

for (const environment of ['dev', 'test', 'prod']) {
  test(`${environment} log retention covers the complete synthesized deployment`, () => {
    const app = new App();
    const config = configuration(environment);
    const props = { env: { account: config.account, region: config.region } };
    const foundation = new Foundation(app, 'foundation', config, props);
    const data = new Data(app, 'data', config, foundation, undefined, [], props);
    const operations = new Operations(app, 'operations', config, foundation, data, 'test-image', props);
    const runtime = new Runtime(app, 'application', config, foundation, data, operations, 'test-image', 'parser-image', 'rest-image', props);
    const delivery = new Delivery(app, 'delivery', data, runtime, props);
    app.synth();
    const groups = [foundation, data, operations, runtime, delivery].flatMap(stack =>
      Object.entries(Template.fromStack(stack).findResources('AWS::Logs::LogGroup'))
        .map(([id, resource]) => ({ stack: stack.stackName, id, resource })),
    );
    assert.equal(groups.length, 7, 'Expected VPC flow logs, database, API/worker sidecars, API, worker and parser logs');
    for (const { stack, id, resource } of groups) {
      const days = resource.Properties?.RetentionInDays;
      if (environment === 'prod') {
        assert.ok(days === undefined || (typeof days === 'number' && days >= 365), `${stack}/${id} must retain at least 365 days or never expire`);
      } else {
        assert.equal(days, 30, `${stack}/${id} should preserve the existing Dev/Test policy`);
      }
      assert.equal(resource.DeletionPolicy, 'Retain');
      assert.equal(resource.UpdateReplacePolicy, 'Retain');
    }
    const flows = Object.values(Template.fromStack(foundation).findResources('AWS::EC2::FlowLog'));
    assert.ok(flows.some(flow => flow.Properties?.LogDestinationType === 'cloud-watch-logs'), 'The policy must include the CloudWatch VPC flow-log destination');
  });
}
