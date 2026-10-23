import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { settings, assertDeploymentEnabled, assertDeployableTemplate } from '../../scripts/deploy/policy.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('unknown environments cannot fall back to Dev and Dev and Test are enabled', () => {
  for (const name of ['', 'unknown', 'constructor', '__proto__']) assert.throws(() => settings(name));
  assert.equal(assertDeploymentEnabled('dev').account, '909762691423');
  assert.equal(assertDeploymentEnabled('test', {}).account, '223323955607');
  for (const name of ['prod']) assert.throws(() => assertDeploymentEnabled(name), /deployment is disabled/);
});

test('every workload deployment helper refuses Prod before invoking AWS, including outside the repo cwd', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cortex-deployment-gate-'));
  const marker = join(directory, 'aws-was-called');
  writeFileSync(join(directory, 'aws'), '#!/bin/sh\necho called > "$AWS_CALL_MARKER"\nexit 99\n', { mode: 0o700 });
  try {
    for (const name of ['prod']) for (const [file, args] of [
      ['policy.mjs', [name]],
      ['release.mjs', [name, 'reviewed-release-123']],
      ['push-images.mjs', [name, 'reviewed-release-123']],
      ['database.mjs', [name]],
      ['apply-stack.mjs', [name, `cortex-${name}-foundation`, 'missing.template.json']],
    ]) {
      const result = spawnSync(process.execPath, [join(root, 'scripts/deploy', file), ...args], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, AWS_CALL_MARKER: marker },
      });
      assert.notEqual(result.status, 0, `${name}/${file} must fail closed`);
      assert.match(result.stderr, /deployment is disabled/, `${name}/${file} must fail at the deployment gate`);
      assert.equal(existsSync(marker), false, `${file} must not call AWS`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('deployment refuses offline fixture templates', () => {
  assert.throws(() => assertDeployableTemplate({ Metadata: { CortexPreparationOnly: true } }), /cannot be deployed/);
  assert.doesNotThrow(() => assertDeployableTemplate({ Resources: {} }));
});

// GitHub credentials are issued only for the branch-bound Test release path.
test('Test rejects other refs and pull requests before AWS access', () => {
  for (const execution of [
    {GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/dev',GITHUB_EVENT_NAME:'push'},
    {GITHUB_ACTIONS:'true',GITHUB_REF:'refs/pull/1/merge',GITHUB_EVENT_NAME:'pull_request'},
    {GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/test',GITHUB_EVENT_NAME:'pull_request'},
  ]) assert.throws(() => assertDeploymentEnabled('test', execution), /requires the test branch/);
  for (const event of ['push','workflow_dispatch']) assert.equal(assertDeploymentEnabled('test',
    {GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/test',GITHUB_EVENT_NAME:event}).account, '223323955607');
});
