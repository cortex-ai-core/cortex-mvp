import { aws,guard,outputs } from './aws.mjs';
const environment=process.argv[2]||'dev';guard(environment);
const settings=outputs(`cortex-${environment}-operations`);
const network={awsvpcConfiguration:{subnets:settings.PrivateSubnets.split(','),securityGroups:[settings.TaskSecurityGroup],assignPublicIp:'DISABLED'}};
const result=aws(['ecs','run-task','--cluster',settings.Cluster,'--task-definition',settings.DatabaseTask,'--launch-type','FARGATE','--network-configuration',JSON.stringify(network)]);
if(result.failures?.length||!result.tasks?.length)throw new Error('Database task failed to start: '+JSON.stringify(result.failures));
const task=result.tasks[0].taskArn;console.log('Started controlled database task:',task);
if(process.argv.includes('--no-wait'))process.exit(0);
for(let attempt=0;attempt<90;attempt++){
  const current=aws(['ecs','describe-tasks','--cluster',settings.Cluster,'--tasks',task]).tasks[0];
  if(current.lastStatus==='STOPPED'){
    if(current.containers.some(c=>c.exitCode!==0))throw new Error(`Database task failed: ${current.stoppedReason}; inspect /cortex/${environment}/database logs.`);
    console.log('Database migration and validation task passed.');process.exit(0);
  }
  await new Promise(r=>setTimeout(r,10000));
}
throw new Error('Database task exceeded the wait limit.');
