import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DnsCertificate, certificateRegions, dnsHostname, certificateRequests } from '../lib/certificates.js';

test('external DNS certificate stacks are regional, retained and contain only one nonexportable certificate', () => {
  for (const purpose of ['viewer', 'origin'] as const) {
    const hostname = `${purpose}.example.invalid`;
    const stack = new DnsCertificate(new App(), purpose, 'dev', purpose, hostname, {
      env: { account: '909762691423', region: certificateRegions[purpose] },
    });
    const template = Template.fromStack(stack);
    const resources = template.toJSON().Resources;
    assert.equal(Object.keys(resources).length, 1, 'No Route53 zone, traffic routing, IAM or workload resources');
    template.hasResource('AWS::CertificateManager::Certificate', {
      DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
      Properties: {
        DomainName: hostname, ValidationMethod: 'DNS', CertificateExport: 'DISABLED', KeyAlgorithm: 'RSA_2048',
      },
    });
    assert.equal(stack.region, purpose === 'viewer' ? 'us-east-1' : 'us-west-2');
  }
});

test('private API requires only a viewer certificate while a public API requires distinct origin DNS', () => {
  assert.deepEqual(certificateRequests('app.example.invalid', undefined), [{ purpose: 'viewer', hostname: 'app.example.invalid' }]);
  assert.equal(certificateRequests('app.example.invalid', 'origin.example.invalid').length, 2);
  assert.throws(() => certificateRequests('app.example.invalid', undefined, true), /public API requires/);
  assert.throws(() => certificateRequests('app.example.invalid', 'app.example.invalid'), /must differ/);
  assert.throws(() => certificateRequests('app.example.invalid', ''), /hostname/);
});

test('certificate bootstrap rejects another account, incorrect service region and broad/invalid hostnames', () => {
  assert.throws(() => new DnsCertificate(new App(), 'account', 'dev', 'viewer', 'app.example.invalid', {
    env: { account: '474711723859', region: 'us-east-1' },
  }));
  assert.throws(() => new DnsCertificate(new App(), 'missing-account', 'dev', 'viewer', 'app.example.invalid', {
    env: { region: 'us-east-1' },
  }));
  assert.throws(() => new DnsCertificate(new App(), 'region', 'dev', 'viewer', 'app.example.invalid', {
    env: { account: '909762691423', region: 'us-west-2' },
  }));
  for (const bad of ['https://app.example.invalid', '*.example.invalid', 'app.example.invalid/path', '-bad.example.invalid', 'one', '']) {
    assert.throws(() => dnsHostname(bad));
  }
  assert.equal(dnsHostname('App.Example.Invalid'), 'app.example.invalid');
});
