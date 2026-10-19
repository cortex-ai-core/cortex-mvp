import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const accounts = Object.freeze({ dev: '909762691423', test: '223323955607', prod: '474711723859' });

export function settings(environment) {
  if (!Object.hasOwn(accounts, environment)) throw new Error('Select dev, test or prod explicitly.');
  const saved = JSON.parse(readFileSync(new URL(`../../infra/environments/${environment}.json`, import.meta.url), 'utf8'));
  if (saved.account !== accounts[environment] || saved.region !== 'us-west-2') throw new Error('Environment account/region configuration mismatch.');
  return saved;
}

export function assertDeploymentEnabled(environment) {
  const saved = settings(environment);
  if (saved.deploymentEnabled !== true) {
    throw new Error(`${environment} deployment is disabled. Complete docs/environment-prerequisites.md and approve a separate enablement PR first.`);
  }
  return saved;
}

export function assertDeployableTemplate(template) {
  if (template.Metadata?.CortexPreparationOnly) {
    throw new Error('Offline preparation templates contain fixtures and cannot be deployed. Synthesize the real environment configuration instead.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertDeploymentEnabled(process.argv[2]);
  console.log(`${process.argv[2]} deployment policy allows the existing release path.`);
}
