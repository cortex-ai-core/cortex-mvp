import { spawnSync } from 'node:child_process';
export const accounts={dev:'909762691423',test:'223323955607',prod:'474711723859'};
export function aws(args,{region='us-west-2',input,allowFailure=false}={}){
  const result=spawnSync('aws',[...args,'--region',region,'--output','json','--no-cli-pager'],{encoding:'utf8',input:input?JSON.stringify(input):undefined,maxBuffer:20*1024*1024,env:{...process.env,AWS_PAGER:''}});
  if(result.status!==0){if(allowFailure)return {failed:true,message:result.stderr};throw new Error(result.stderr.trim()||'AWS CLI request failed');}
  return result.stdout.trim()?JSON.parse(result.stdout):null;
}
export function guard(environment='dev'){
  if(!accounts[environment])throw new Error('Select dev, test or prod.');
  const identity=aws(['sts','get-caller-identity']);
  if(identity.Account!==accounts[environment])throw new Error(`Account mismatch: ${environment} requires ${accounts[environment]}.`);
  if(process.env.AWS_REGION && process.env.AWS_REGION!=='us-west-2')throw new Error('Only Oregon deployments are allowed.');
  return identity;
}
export function outputs(stack){return Object.fromEntries(aws(['cloudformation','describe-stacks','--stack-name',stack]).Stacks[0].Outputs.map(o=>[o.OutputKey,o.OutputValue]));}
