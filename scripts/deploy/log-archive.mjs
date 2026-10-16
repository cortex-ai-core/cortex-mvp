import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {aws} from './aws.mjs';
const account=aws(['sts','get-caller-identity']).Account;
if(account!=='747301449112'||process.env.AWS_REGION!=='us-west-2')throw new Error('A verified SolluCIO Log Archive Oregon session is required.');
const stack='cortex-central-flowlogs',file='infra/cdk.out-logs/cortex-central-flowlogs.template.json';
const template=JSON.parse(await readFile(file,'utf8'));
await mkdir('.local/deployment',{recursive:true,mode:0o700});
const compact=resolve('.local/deployment/cortex-central-flowlogs.json');
await writeFile(compact,JSON.stringify(template),{mode:0o600});
const prior=aws(['cloudformation','describe-stacks','--stack-name',stack],{allowFailure:true});
if(prior.failed&&!/does not exist/.test(prior.message))throw new Error(prior.message);
if(!prior.failed&&!['CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE'].includes(prior.Stacks[0].StackStatus))throw new Error('Central stack is busy or needs recovery.');
const name=`reviewed-${Date.now()}`;
aws(['cloudformation','create-change-set','--stack-name',stack,'--change-set-name',name,'--change-set-type',prior.failed?'CREATE':'UPDATE','--template-body',`file://${compact}`]);
let change;
for(let attempt=0;attempt<60;attempt++){
 change=aws(['cloudformation','describe-change-set','--stack-name',stack,'--change-set-name',name]);
 if(!['CREATE_PENDING','CREATE_IN_PROGRESS'].includes(change.Status))break;
 await new Promise(r=>setTimeout(r,2000));
}
if(change.Status==='FAILED'&&/didn't contain changes|No updates/.test(change.StatusReason||'')){console.log('Central logging: no changes.');process.exit(0);}
if(change.Status!=='CREATE_COMPLETE')throw new Error(change.StatusReason||'Change set creation failed.');
if(change.Changes.some(c=>c.ResourceChange.Action==='Remove'||(c.ResourceChange.ResourceType==='AWS::S3::Bucket'&&c.ResourceChange.Replacement&&c.ResourceChange.Replacement!=='False')))throw new Error('Refusing central bucket replacement or resource removal.');
console.log(JSON.stringify({account,stack,changes:change.Changes.map(c=>({action:c.ResourceChange.Action,type:c.ResourceChange.ResourceType,replacement:c.ResourceChange.Replacement}))}));
aws(['cloudformation','execute-change-set','--stack-name',stack,'--change-set-name',name]);
console.log('Central logging change set executed; verify stack completion and actual log delivery.');
