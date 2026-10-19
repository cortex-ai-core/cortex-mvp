import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { accounts, settings } from './policy.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const selected = process.argv[2] ? [process.argv[2]] : Object.keys(accounts);
const reports = selected.map(environment => {
  const saved = settings(environment);
  const missing = ['image', 'parserImage', 'postgrestImage', 'publicOrigin', 'dns', 'certificates']
    .filter(field => !saved[field]);
  return { environment, account: saved.account, region: saved.region,
    deploymentEnabled: saved.deploymentEnabled === true,
    missingConfiguration: missing,
    liveReadiness: 'NOT CHECKED: account access, GitHub protections, DNS, secrets, quotas, data approval and acceptance require separate verification.' };
});
for (const report of reports) {
  // Do not let the CDK process load a user's AWS session or perform context lookups.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AWS_') && !key.startsWith('CDK_')));
  Object.assign(env, { CDK_DEFAULT_ACCOUNT: report.account, CDK_DEFAULT_REGION: report.region,
    AWS_EC2_METADATA_DISABLED: 'true', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_CONFIG_FILE: '/dev/null' });
  execFileSync(process.execPath, [join(root, 'infra/node_modules/aws-cdk/bin/cdk'), 'synth',
    '--app', 'node_modules/.bin/tsx bin/preparation.ts', '--no-lookups', '--quiet',
    '-c', `environment=${report.environment}`, '--output', join(root, '.local/preparation', report.environment)],
  { cwd: join(root, 'infra'), env, stdio: 'inherit' });
  console.log(`${report.environment}: offline synthesis passed; deployment ${report.deploymentEnabled ? 'enabled for existing Dev path' : 'LOCKED'}.`);
}
mkdirSync(join(root, '.local/preparation'), { recursive: true });
writeFileSync(join(root, '.local/preparation/readiness.json'), JSON.stringify({
  preparationOnly: true, deployable: false, environments: reports,
}, null, 2) + '\n');
console.log('Local report: .local/preparation/readiness.json. No AWS calls, resources, change sets or deployments were made.');
