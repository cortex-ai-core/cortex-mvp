import { spawnSync } from 'node:child_process';
import { guard } from './aws.mjs';
const [environment='dev',tag]=process.argv.slice(2);
if(!/^[a-zA-Z0-9_.-]+$/.test(tag||''))throw new Error('Provide an immutable release tag.');
const {Account}=guard(environment);
const registry=`${Account}.dkr.ecr.us-west-2.amazonaws.com`;
const token=spawnSync('aws',['ecr','get-login-password','--region','us-west-2'],{encoding:'utf8'});
if(token.status!==0)throw new Error('ECR authentication failed.');
const login=spawnSync('docker',['login','--username','AWS','--password-stdin',registry],{input:token.stdout,stdio:['pipe','inherit','inherit']});
if(login.status!==0)throw new Error('Docker ECR login failed.');
for(const [name,local]of [['api','cortex-api:oregon-dev'],['postgrest','cortex-postgrest:oregon-dev'],['parser','cortex-parser:aws-local']]){
  const target=`${registry}/cortex-${environment}-${name}:${tag}`;
  if(spawnSync('docker',['tag',local,target],{stdio:'inherit'}).status!==0)throw new Error(`Tag failed: ${name}`);
  if(spawnSync('docker',['push',target],{stdio:'inherit'}).status!==0)throw new Error(`Push failed: ${name}`);
  console.log(`Published ${name}: ${tag}`);
}
