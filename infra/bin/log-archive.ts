import { App, BootstraplessSynthesizer, Tags } from 'aws-cdk-lib';
import { LogArchive,centralLogs } from '../lib/log-archive.js';
if(process.env.CDK_DEFAULT_ACCOUNT&&process.env.CDK_DEFAULT_ACCOUNT!==centralLogs.account)throw new Error('Use a dedicated Log Archive session.');
if((process.env.AWS_REGION||process.env.CDK_DEFAULT_REGION||centralLogs.region)!==centralLogs.region)throw new Error('Central logging is Oregon only.');
const app=new App();
new LogArchive(app,'cortex-central-flowlogs',{env:{account:centralLogs.account,region:centralLogs.region},synthesizer:new BootstraplessSynthesizer()});
Tags.of(app).add('ManagedBy','CloudFormation');
Tags.of(app).add('Project','Cortex');
