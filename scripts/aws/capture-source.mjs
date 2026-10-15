// Read-only Ohio export: schema and aggregate fingerprints; no application rows are written to disk.
import pg from 'pg';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { schemaSignature } from '../deploy/schema-signature.mjs';
const account='909762691423';
const identity=await new STSClient({region:'us-west-2'}).send(new GetCallerIdentityCommand({}));
if(identity.Account!==account) throw new Error('Expected SolluCIO Cortex-Dev.');
const secret=await new SecretsManagerClient({region:'us-east-2'}).send(new GetSecretValueCommand({SecretId:process.env.SOURCE_ADMIN_SECRET}));
const credentials=JSON.parse(secret.SecretString);
const host='cortex-rds.cvcm2qq6u67z.us-east-2.rds.amazonaws.com';
const caPath=new URL('../migration/.local/us-east-2-bundle.pem',import.meta.url);
const client=new pg.Client({host,database:'cortex',user:credentials.username,password:credentials.password,connectionTimeoutMillis:15000,ssl:{ca:await readFile(caPath,'utf8'),rejectUnauthorized:true}});
await client.connect();
try {
  const {rows:tables}=await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const counts={},fingerprints={};
  for(const {tablename} of tables){
    const name='public."'+tablename.replaceAll('"','""')+'"';
    const {rows}=await client.query(`SELECT count(*)::int AS count,md5(coalesce(string_agg(h,'' ORDER BY h),'')) AS fingerprint FROM (SELECT md5(row_to_json(t)::text) AS h FROM ${name} t) x`);
    counts[tablename]=rows[0].count;fingerprints[tablename]=rows[0].fingerprint;
  }
  const dockerEnv={...process.env,PGHOST:host,PGDATABASE:'cortex',PGUSER:credentials.username,PGPASSWORD:credentials.password,PGSSLMODE:'verify-full',PGSSLROOTCERT:'/rds-ca.pem'};
  const args=['run','--rm','--env','PGHOST','--env','PGDATABASE','--env','PGUSER','--env','PGPASSWORD','--env','PGSSLMODE','--env','PGSSLROOTCERT','--mount',`type=bind,source=${caPath.pathname},target=/rds-ca.pem,readonly`,'postgres:18-bookworm','pg_dump','--schema-only','--no-owner','--no-acl','--schema=public','--schema=extensions','--schema=migration'];
  const dump=spawnSync('docker',args,{env:dockerEnv,encoding:'utf8',maxBuffer:20*1024*1024});
  if(dump.status!==0) throw new Error('Source schema export failed: '+dump.stderr.replaceAll(credentials.password,'[redacted]'));
  if(/(?:AKIA|ASIA)[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}/.test(dump.stdout)) throw new Error('Potential credential literal found in schema; export withheld.');
  // pg_dump random restriction markers are psql-specific; migrations run SQL through pg.
  const extensions=(await client.query("SELECT e.extname,n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname<>'plpgsql' ORDER BY e.extname")).rows;
  const prelude=extensions.map(e=>`CREATE EXTENSION IF NOT EXISTS "${e.extname}" WITH SCHEMA "${e.schema}";`).join('\n');
  const sql='CREATE SCHEMA IF NOT EXISTS extensions;\n'+prelude+'\n'+dump.stdout.replace(/^\\(?:un)?restrict .*\n/gm,'').replace(/CREATE SCHEMA (public|extensions|migration);/g,'CREATE SCHEMA IF NOT EXISTS $1;');
  await writeFile(new URL('../../database/migrations/0000_baseline.sql',import.meta.url),sql);
  await writeFile(new URL('../../database/baseline-manifest.json',import.meta.url),JSON.stringify(await schemaSignature(client),null,2)+'\n');
  await mkdir(new URL('../../.local/migration/',import.meta.url),{recursive:true,mode:0o700});
  const report={account,region:'us-east-2',database:'cortex',at:new Date().toISOString(),counts,fingerprints};
  await writeFile(new URL('../../.local/migration/source-report.json',import.meta.url),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({schemaExported:true,tableCounts:counts}));
} finally {await client.end();}
