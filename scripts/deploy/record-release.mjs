import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { aws, guard, outputs } from './aws.mjs';
const [environment, tag, parserTag, postgrestTag] = process.argv.slice(2);
const identity = guard(environment);
if (!tag) throw new Error('An explicit API image tag is required.');
const { settings } = await import('./policy.mjs');
const saved = settings(environment);
const images = {};
for (const [name, imageTag] of Object.entries({ api: tag, parser: parserTag || saved.parserImage, postgrest: postgrestTag || saved.postgrestImage })) {
  const response = aws(['ecr', 'describe-images', '--repository-name', `cortex-${environment}-${name}`, '--image-ids', `imageTag=${imageTag}`]);
  images[name] = { tag: imageTag, digest: response.imageDetails[0].imageDigest };
}
const source = await readFile('.local/promotion/source.json', 'utf8').then(JSON.parse).catch(error => { if(error.code === 'ENOENT')return undefined;throw error; });
const manifest = { environment, account: identity.Account, commit: source?.commit || process.env.GITHUB_SHA, deploymentCommit: process.env.GITHUB_SHA, source, run: process.env.GITHUB_RUN_ID,
  at: new Date().toISOString(), images, delivery: outputs(`cortex-${environment}-delivery`) };
await mkdir('.local/deployment', { recursive: true });
await writeFile('.local/deployment/release.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
