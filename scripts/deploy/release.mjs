import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { guard,outputs,aws } from './aws.mjs';
const [environment='dev',image,parserImage,postgrestImage]=process.argv.slice(2);
if(!/^[a-z0-9][a-z0-9_.-]{6,100}$/.test(image||''))throw new Error('Supply an immutable image tag.');
for(const tag of [parserImage,postgrestImage].filter(Boolean))if(!/^[a-z0-9][a-z0-9_.-]{6,100}$/.test(tag))throw new Error('Invalid supporting image tag.');
const identity=guard(environment);
const saved=JSON.parse(await readFile(`infra/environments/${environment}.json`,'utf8'));
if(saved.account!==identity.Account||saved.region!=='us-west-2')throw new Error('Environment configuration mismatch.');
const run=(args,cwd=process.cwd())=>{if(spawnSync(args[0],args.slice(1),{cwd,stdio:'inherit',env:process.env}).status!==0)throw new Error(`Release step failed: ${args[0]}`);};
const context=['-c',`environment=${environment}`,'-c','includeData=true','-c','includeRuntime=true','-c',`image=${image}`];
if(parserImage)context.push('-c',`parserImage=${parserImage}`);
if(postgrestImage)context.push('-c',`postgrestImage=${postgrestImage}`);
if(saved.viewerActivation==='when-issued'){
  const certificate=aws(['acm','describe-certificate','--certificate-arn',saved.certificates.viewer],{region:'us-east-1'}).Certificate;
  if(certificate.Status==='ISSUED')context.push('-c','viewerCertificateReady=true');
  else console.log(`Custom viewer certificate ${certificate.Status}; retaining the generated CloudFront URL until DNS validation completes.`);
}
run(['npm','run','synth','--',...context,'--quiet'],`${process.cwd()}/infra`);
// Test's branch-driven rollout includes its foundation. Dev remains a separate infrastructure operation.
if(environment==='test')run(['node','scripts/deploy/apply-stack.mjs',environment,`cortex-${environment}-foundation`,`infra/cdk.out/cortex-${environment}-foundation.template.json`]);
for(const stack of ['data','operations'])run(['node','scripts/deploy/apply-stack.mjs',environment,`cortex-${environment}-${stack}`,`infra/cdk.out/cortex-${environment}-${stack}.template.json`]);
run(['node','scripts/deploy/database.mjs',environment]);
for(const stack of ['application','delivery'])run(['node','scripts/deploy/apply-stack.mjs',environment,`cortex-${environment}-${stack}`,`infra/cdk.out/cortex-${environment}-${stack}.template.json`]);
console.log('Deployed backend:',outputs(`cortex-${environment}-delivery`).Url);
