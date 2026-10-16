import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStorage,localFilePath } from '../../backend/lib/services/localStorage.js';
test('local storage cannot be enabled in production or cloud mode',()=>{
  assert.throws(()=>createLocalStorage({CORTEX_ENV:'aws',NODE_ENV:'production'}));
  assert.throws(()=>createLocalStorage({CORTEX_ENV:'local',NODE_ENV:'production'}));
});
test('local object paths cannot escape their storage root',()=>{
  assert.throws(()=>localFilePath('../../.env.aws','/tmp/cortex-test-root'));
  assert.throws(()=>localFilePath('/etc/passwd','/tmp/cortex-test-root'));
  assert.equal(localFilePath('namespace/document/original.pdf','/tmp/cortex-test-root'),'/tmp/cortex-test-root/namespace/document/original.pdf');
});
