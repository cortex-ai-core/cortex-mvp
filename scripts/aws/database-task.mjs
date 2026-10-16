// Runs inside the VPC using its own restricted ECS role. Never writes to Ohio.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { schemaSignature } from '../deploy/schema-signature.mjs';

if (process.env.AWS_REGION !== 'us-west-2') throw new Error('Only Oregon database operations are permitted.');
const identity = await new STSClient({region:'us-west-2'}).send(new GetCallerIdentityCommand({}));
if (identity.Account !== process.env.CORTEX_ACCOUNT_ID) throw new Error('Account mismatch.');
const client = new pg.Client({ host:process.env.PGHOST, database:process.env.PGDATABASE, user:process.env.PGUSER, password:process.env.PGPASSWORD, ssl:{ca:await readFile(process.env.PGSSLROOTCERT,'utf8'),rejectUnauthorized:true} });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('cortex-schema-migrations'))");
  await client.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='cortex_backend') THEN CREATE ROLE cortex_backend NOLOGIN NOINHERIT; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='cortex_postgrest') THEN CREATE ROLE cortex_postgrest LOGIN NOINHERIT; END IF; END $$;");
  if (process.env.CORTEX_DB_PASSWORD) {
    if (!/^[a-zA-Z0-9]{32,}$/.test(process.env.CORTEX_DB_PASSWORD)) throw new Error('Invalid generated role password.');
    await client.query(`ALTER ROLE cortex_postgrest PASSWORD '${process.env.CORTEX_DB_PASSWORD}'`);
  }
  await client.query('CREATE SCHEMA IF NOT EXISTS cortex_migrations');
  await client.query('CREATE TABLE IF NOT EXISTS cortex_migrations.applied (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  const { readdir } = await import('node:fs/promises');
  for (const file of (await readdir('/app/database/migrations')).filter(f=>/^\d+.*\.sql$/.test(f)).sort()) {
    const sql = await readFile(`/app/database/migrations/${file}`,'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query('SELECT checksum FROM cortex_migrations.applied WHERE version=$1',[file]);
    if (existing.rows.length) { if (existing.rows[0].checksum!==checksum) throw new Error(`Applied migration changed: ${file}`); continue; }
    if (file.startsWith('0000')) {
      const exists = await client.query("SELECT to_regclass('public.documents') AS documents");
      if(!exists.rows[0].documents) {
        await client.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='cortex_backend') THEN CREATE ROLE cortex_backend NOLOGIN NOINHERIT; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='cortex_postgrest') THEN CREATE ROLE cortex_postgrest LOGIN NOINHERIT; END IF; END $$;");
        await client.query(sql);
      }
      const expected=JSON.parse(await readFile('/app/database/baseline-manifest.json','utf8'));
      const actual=await schemaSignature(client);
      if(actual.sha256!==expected.sha256)throw new Error('Database does not match the captured baseline; refusing to mark it applied.');
    } else await client.query(sql);
    await client.query('INSERT INTO cortex_migrations.applied(version,checksum) VALUES($1,$2)',[file,checksum]);
  }
  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query('COMMIT');
  const {rows:tables}=await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const counts={},fingerprints={};
  for (const {tablename} of tables) {
    const {rows}=await client.query(`SELECT count(*)::int AS count,md5(coalesce(string_agg(h,'' ORDER BY h),'')) AS fingerprint FROM (SELECT md5(row_to_json(t)::text) AS h FROM public."${tablename.replaceAll('"','""')}" t) x`);
    counts[tablename]=rows[0].count;
    fingerprints[tablename]=rows[0].fingerprint;
  }
  const dump=spawnSync('pg_dump',['--schema-only','--no-owner','--no-acl','--schema=public','--schema=extensions'],{encoding:'utf8',maxBuffer:20*1024*1024});
  if (dump.status!==0) throw new Error('Schema export failed; inspect database task without printing connection secrets.');
  const s3=new S3Client({region:'us-west-2'});
  const report={account:identity.Account,region:'us-west-2',at:new Date().toISOString(),counts,fingerprints};
  await s3.send(new PutObjectCommand({Bucket:process.env.MIGRATION_BUCKET,Key:'verification/oregon-database.json',Body:JSON.stringify(report,null,2),ContentType:'application/json'}));
  await s3.send(new PutObjectCommand({Bucket:process.env.MIGRATION_BUCKET,Key:'schema/oregon-schema.sql',Body:dump.stdout,ContentType:'application/sql'}));
  console.log(JSON.stringify(report));
  s3.destroy();
} catch(error) {
  await client.query('ROLLBACK').catch(()=>{});
  console.error('Oregon database task failed:',error.message);
  process.exitCode=1;
} finally { await client.end(); }
