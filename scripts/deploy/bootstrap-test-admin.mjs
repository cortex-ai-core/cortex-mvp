// Administrator-only, one-time operation. Never invoked by release.mjs or CI.
import { readFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { aws, guard, outputs } from './aws.mjs';
import { bootstrapConfiguration } from '../aws/bootstrap-test-admin.mjs';

const [mode, email, subject] = process.argv.slice(2);
const data = {
  BOOTSTRAP_MODE: mode, BOOTSTRAP_EMAIL: email, BOOTSTRAP_SUBJECT: subject || '',
  BOOTSTRAP_ORGANIZATION: process.env.BOOTSTRAP_ORGANIZATION || 'Sollucio Partners',
  BOOTSTRAP_WORKSPACE: process.env.BOOTSTRAP_WORKSPACE || 'core',
  BOOTSTRAP_USER_POOL_ID: 'us-west-2_jkRHTdgKB', BOOTSTRAP_RUN_ID: process.env.BOOTSTRAP_RUN_ID || randomUUID(),
};
bootstrapConfiguration({ ...data, AWS_REGION: 'us-west-2', CORTEX_ACCOUNT_ID: '223323955607',
  PGHOST: 'cortex-test-oregon.cp6g8aywalrw.us-west-2.rds.amazonaws.com', PGDATABASE: 'cortex',
  MIGRATION_BUCKET: 'cortex-migration-test-223323955607-us-west-2' });
guard('test');
const sourcePath = resolve('scripts/aws/bootstrap-test-admin.mjs');
const source = await readFile(sourcePath);
const digest = createHash('sha256').update(source).digest('hex');
const bucket = 'cortex-migration-test-223323955607-us-west-2';
const key = `bootstrap/source/${digest}/bootstrap-test-admin.mjs`;
const uploaded = aws(['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', sourcePath, '--content-type', 'text/javascript']);
if (!uploaded.VersionId) throw new Error('A versioned source artifact is required.');
// Existing database image supplies dependencies. Download only this pinned source;
// use writable /tmp and reuse /app/node_modules without changing the image.
const launcher = `import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3';
import {mkdir,writeFile,symlink} from 'node:fs/promises';import {createHash} from 'node:crypto';
const s3=new S3Client({region:'us-west-2'});
const object=await s3.send(new GetObjectCommand(${JSON.stringify({ Bucket: bucket, Key: key, VersionId: uploaded.VersionId })}));
const source=await object.Body.transformToString();s3.destroy();
if(createHash('sha256').update(source).digest('hex')!==${JSON.stringify(digest)})throw new Error('Bootstrap source checksum mismatch.');
await mkdir('/tmp/cortex-bootstrap',{recursive:true});await symlink('/app/node_modules','/tmp/cortex-bootstrap/node_modules');
await writeFile('/tmp/cortex-bootstrap/bootstrap.mjs',source,{mode:0o600});
await (await import('file:///tmp/cortex-bootstrap/bootstrap.mjs')).bootstrapTestAdmin();`;
const settings = outputs('cortex-test-operations');
const result = aws(['ecs', 'run-task', '--cluster', settings.Cluster, '--task-definition', settings.DatabaseTask,
  '--launch-type', 'FARGATE', '--started-by', `test-admin-${mode}`,
  '--network-configuration', JSON.stringify({ awsvpcConfiguration: {
    subnets: settings.PrivateSubnets.split(','), securityGroups: [settings.TaskSecurityGroup], assignPublicIp: 'DISABLED',
  } }), '--overrides', JSON.stringify({ containerOverrides: [{ name: 'database',
    command: ['node', '--input-type=module', '--eval', launcher],
    environment: Object.entries(data).map(([name, value]) => ({ name, value })),
  }] })]);
if (result.failures?.length || !result.tasks?.length) throw new Error('Bootstrap task failed to start.');
const task = result.tasks[0].taskArn;
const reportKey = `bootstrap/reports/${data.BOOTSTRAP_RUN_ID}/${mode}.json`;
console.log(JSON.stringify({ task, mode, source: { bucket, key, versionId: uploaded.VersionId, digest }, reportKey }));
for (let attempt = 0; attempt < 180; attempt++) {
  const current = aws(['ecs', 'describe-tasks', '--cluster', settings.Cluster, '--tasks', task]).tasks[0];
  if (current.lastStatus === 'STOPPED') {
    if (current.containers.some(container => container.exitCode !== 0)) throw new Error(`Bootstrap task failed. Inspect /cortex/test/database; task ${task}. Do not reset/delete the Cognito identity without checking database state.`);
    const directory = resolve(`.local/deployment/admin-bootstrap/${data.BOOTSTRAP_RUN_ID}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = `${directory}/${mode}.json`;
    aws(['s3api', 'get-object', '--bucket', bucket, '--key', reportKey, path]);
    console.log(await readFile(path, 'utf8'));
    process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve, 5000));
}
throw new Error(`Bootstrap task wait timed out; inspect ${task} before retrying.`);
