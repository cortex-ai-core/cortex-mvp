import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { aws, guard } from './aws.mjs';
import { imageTag } from './dev-release.mjs';
const mode = process.argv[2];
if (!['capture', 'copy'].includes(mode)) throw new Error('Choose capture or copy.');
const source = JSON.parse(await readFile('.local/promotion/source.json', 'utf8'));
if (source.repository !== 'cortex-ai-core/cortex-mvp' || !/^[a-f0-9]{40}$/.test(source.commit)) throw new Error('Invalid promotion source.');
if (mode === 'capture') {
  if (aws(['sts', 'get-caller-identity']).Account !== '909762691423') throw new Error('Source credentials must identify Dev.');
} else guard('test');
for (const name of ['api', 'parser', 'postgrest']) {
  const image = source.images[name], tag = imageTag(image.tag);
  if (mode === 'capture') {
    image.digest = aws(['ecr', 'describe-images', '--repository-name', `cortex-dev-${name}`, '--image-ids', `imageTag=${tag}`]).imageDetails[0].imageDigest;
  } else {
    if (!/^sha256:[a-f0-9]{64}$/.test(image.digest)) throw new Error('Missing approved source digest.');
    const from = `909762691423.dkr.ecr.us-west-2.amazonaws.com/cortex-dev-${name}@${image.digest}`;
    const to = `223323955607.dkr.ecr.us-west-2.amazonaws.com/cortex-test-${name}:${tag}`;
    if (spawnSync('crane', ['copy', from, to], { stdio: 'inherit' }).status !== 0) throw new Error(`${name} copy failed.`);
    const actual = aws(['ecr', 'describe-images', '--repository-name', `cortex-test-${name}`, '--image-ids', `imageTag=${tag}`]).imageDetails[0].imageDigest;
    if (actual !== image.digest) throw new Error(`${name} destination digest mismatch.`);
  }
}
await writeFile('.local/promotion/source.json', JSON.stringify(source, null, 2));
console.log(`${mode}: all three image digests recorded/verified.`);
