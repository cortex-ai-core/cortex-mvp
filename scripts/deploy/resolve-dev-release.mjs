import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { devRun, github, imageTag } from './dev-release.mjs';
const source = await devRun('cortex-ai-core/cortex-mvp', process.argv[2]);
const file = await (await github(`${source.repository}/contents/infra/environments/dev.json?ref=${source.commit}`)).json();
const config = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
source.images = {
  api: { tag: imageTag(`git-${source.commit}-${source.runId}-${source.runAttempt}`) },
  parser: { tag: imageTag(config.parserImage) },
  postgrest: { tag: imageTag(config.postgrestImage) },
};
await mkdir('.local/promotion', { recursive: true });
await writeFile('.local/promotion/source.json', JSON.stringify(source, null, 2));
if (process.env.GITHUB_OUTPUT) for (const [name, image] of Object.entries(source.images)) await appendFile(process.env.GITHUB_OUTPUT, `${name}_tag=${image.tag}\n`);
console.log(JSON.stringify(source));
