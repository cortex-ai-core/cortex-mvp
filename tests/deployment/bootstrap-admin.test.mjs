import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapConfiguration, bootstrapRoles, validateBootstrapState } from '../../scripts/aws/bootstrap-test-admin.mjs';

const env = { AWS_REGION: 'us-west-2', CORTEX_ACCOUNT_ID: '223323955607',
  PGHOST: 'cortex-test-oregon.cp6g8aywalrw.us-west-2.rds.amazonaws.com', PGDATABASE: 'cortex',
  MIGRATION_BUCKET: 'cortex-migration-test-223323955607-us-west-2', BOOTSTRAP_USER_POOL_ID: 'us-west-2_jkRHTdgKB',
  BOOTSTRAP_MODE: 'apply', BOOTSTRAP_EMAIL: 'admin@example.invalid', BOOTSTRAP_ORGANIZATION: 'Fresh Test',
  BOOTSTRAP_WORKSPACE: 'Test Workspace', BOOTSTRAP_SUBJECT: '11111111-1111-4111-8111-111111111111',
  BOOTSTRAP_RUN_ID: '22222222-2222-4222-8222-222222222222' };
const config = bootstrapConfiguration(env);
const counts = { role: 5, organization: 1, namespace: 1, user: 1, namespace_users: 1, auth_identities: 1, documents: 0 };
const identity = { email: config.email, active: true, role: 'super_admin', organization: config.organization,
  workspace: config.workspace, provider: 'cognito', issuer: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_jkRHTdgKB', subject: config.subject };

test('bootstrap refuses another account, host, pool or invalid identity inputs', () => {
  for (const key of ['CORTEX_ACCOUNT_ID', 'AWS_REGION', 'PGHOST', 'PGDATABASE', 'MIGRATION_BUCKET', 'BOOTSTRAP_USER_POOL_ID', 'BOOTSTRAP_SUBJECT', 'BOOTSTRAP_EMAIL']) {
    assert.throws(() => bootstrapConfiguration({ ...env, [key]: 'wrong' }));
  }
});
test('first application requires empty tables and verification refuses missing setup', () => {
  const empty = Object.fromEntries(Object.keys(counts).map(name => [name, 0]));
  assert.equal(validateBootstrapState(empty, null, [], config), 'empty');
  assert.throws(() => validateBootstrapState(empty, null, [], { ...config, mode: 'verify' }));
  assert.throws(() => validateBootstrapState({}, null, [], config));
});
test('exact repeat is idempotent; preflight refuses to create another initial admin', () => {
  assert.equal(validateBootstrapState(counts, identity, bootstrapRoles, config), 'already-configured');
  assert.throws(() => validateBootstrapState(counts, identity, bootstrapRoles, { ...config, mode: 'preflight' }));
});
test('bootstrap refuses existing application content, unrelated identities or incomplete setup', () => {
  assert.throws(() => validateBootstrapState({ ...counts, documents: 1 }, identity, bootstrapRoles, config));
  assert.throws(() => validateBootstrapState({ ...counts, user: 2 }, identity, bootstrapRoles, config));
  for (const key of ['email', 'active', 'role', 'organization', 'workspace', 'issuer', 'subject']) {
    assert.throws(() => validateBootstrapState(counts, { ...identity, [key]: 'wrong' }, bootstrapRoles, config));
  }
  assert.throws(() => validateBootstrapState(counts, identity, ['super_admin'], config));
});
