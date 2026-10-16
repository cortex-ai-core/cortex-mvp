import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { aws,guard } from './aws.mjs';
const [environment,stack,file]=process.argv.slice(2);
guard(environment);
if(!stack?.startsWith(`cortex-${environment}-`))throw new Error('Unexpected stack name.');
const template=JSON.parse(await readFile(resolve(file),'utf8'));
await mkdir('.local/deployment',{recursive:true,mode:0o700});
const compact=resolve(`.local/deployment/${stack}.json`);
const body=JSON.stringify(template);
if(Buffer.byteLength(body)>51200)throw new Error('Template exceeds inline limit: use a reviewed S3 artifact transport.');
await writeFile(compact,body,{mode:0o600});
const prior=aws(['cloudformation','describe-stacks','--stack-name',stack],{allowFailure:true});
if(prior?.failed && !/does not exist/.test(prior.message))throw new Error(prior.message);
const type=prior?.failed?'CREATE':'UPDATE';
if(!prior?.failed && !['CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE'].includes(prior.Stacks[0].StackStatus))throw new Error('Stack is busy or requires recovery.');
const name=`release-${Date.now()}`;
const args=['cloudformation','create-change-set','--stack-name',stack,'--change-set-name',name,'--change-set-type',type,'--template-body',`file://${compact}`,'--capabilities','CAPABILITY_NAMED_IAM'];
if(!stack.endsWith('-foundation') || type==='UPDATE')args.push('--role-arn',`arn:aws:iam::${guard(environment).Account}:role/cortex-${environment}-cloudformation`);
aws(args);
let change;
for(let attempt=0;attempt<60;attempt++){
  change=aws(['cloudformation','describe-change-set','--stack-name',stack,'--change-set-name',name]);
  if(!['CREATE_PENDING','CREATE_IN_PROGRESS'].includes(change.Status))break;
  await new Promise(r=>setTimeout(r,2000));
}
if(change.Status==='FAILED' && /didn't contain changes|No updates/.test(change.StatusReason||'')){console.log(`${stack}: no changes`);process.exit(0);}
if(change.Status!=='CREATE_COMPLETE')throw new Error(change.StatusReason||'Change set was not created.');
for(const entry of change.Changes||[]){
  const c=entry.ResourceChange;
  if(c.Action==='Remove' && !(process.argv.find(a=>a.startsWith('--allow-remove='))||'').slice(15).split(',').includes(c.LogicalResourceId))throw new Error(`Removal requires a separately reviewed operation: ${c.LogicalResourceId}`);
  if(c.Replacement && c.Replacement!=='False' && ['AWS::RDS::DBInstance','AWS::S3::Bucket','AWS::Cognito::UserPool','AWS::KMS::Key'].includes(c.ResourceType))throw new Error(`Refusing persistent resource replacement: ${c.LogicalResourceId}`);
}
console.log(JSON.stringify({stack,changeSet:name,changes:change.Changes.map(c=>({action:c.ResourceChange.Action,type:c.ResourceChange.ResourceType,replacement:c.ResourceChange.Replacement}))}));
aws(['cloudformation','execute-change-set','--stack-name',stack,'--change-set-name',name]);
if(process.argv.includes('--no-wait'))process.exit(0);
for(let attempt=0;attempt<240;attempt++){
  const current=aws(['cloudformation','describe-stacks','--stack-name',stack]).Stacks[0];
  if(['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(current.StackStatus)){console.log(`${stack}: ${current.StackStatus}`);process.exit(0);}
  if(/FAILED|ROLLBACK/.test(current.StackStatus))throw new Error(`${stack}: ${current.StackStatus}; inspect stack events.`);
  await new Promise(r=>setTimeout(r,10000));
}
throw new Error('Deployment exceeded the wait limit; inspect stack status before retrying.');
