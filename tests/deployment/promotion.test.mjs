import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDevRun, imageTag, validateWebArtifact } from '../../scripts/deploy/dev-release.mjs';
const repo='cortex-ai-core/cortex-mvp';
const good={repository:{full_name:repo},event:'push',head_branch:'dev',status:'completed',conclusion:'success',path:'.github/workflows/aws.yml',head_sha:'a'.repeat(40),id:123,run_attempt:2};
test('promotion accepts only successful Dev release runs, including exact retry attempt',()=>{
 assert.deepEqual(validateDevRun(good,repo),{repository:repo,runId:123,runAttempt:2,commit:'a'.repeat(40)});
 for(const patch of [{event:'pull_request'},{head_branch:'test'},{conclusion:'failure'},{status:'in_progress'},{path:'.github/workflows/untrusted.yml'},{repository:{full_name:'other/repo'}},{head_sha:'bad'},{run_attempt:0}])assert.throws(()=>validateDevRun({...good,...patch},repo));
});
test('promotion image tags cannot contain shell syntax, paths or digest overrides',()=>{
 assert.equal(imageTag('migration-20261015-1'),'migration-20261015-1');
 for(const tag of ['latest','../../repo','$(id)','tag;command','sha256:123'])assert.throws(()=>imageTag(tag));
});

test('website promotion rejects expired, missing or unverifiable artifacts',()=>{
 const good={name:'static-web',id:42,expired:false,digest:'sha256:'+ 'a'.repeat(64)};
 assert.equal(validateWebArtifact(good),good);
 for(const value of [undefined,{...good,expired:true},{...good,digest:undefined},{...good,name:'other'}])assert.throws(()=>validateWebArtifact(value));
});
