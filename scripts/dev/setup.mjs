import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { randomBytes,createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import pg from 'pg';
import { guard,outputs,aws } from '../deploy/aws.mjs';
import { schemaSignature } from '../deploy/schema-signature.mjs';

const databaseOnly=process.argv.includes('--database-only');
const emailIndex=process.argv.indexOf('--email');
const email=emailIndex>=0?process.argv[emailIndex+1]?.trim().toLowerCase():null;
if(!databaseOnly&&!email)throw new Error('Use npm run setup:local -- --email YOUR_COGNITO_EMAIL, or --database-only for database tests.');
let cloud,profile;
if(!databaseOnly){
  guard('dev');cloud=outputs('cortex-dev-data');
  profile=aws(['cognito-idp','admin-get-user','--user-pool-id',cloud.UserPoolId,'--username',email],{allowFailure:true});
  if(profile?.failed){
    profile=aws(['cognito-idp','admin-get-user','--user-pool-id','us-east-2_gfKKl0wNa','--username',email],{region:'us-east-2'});
    profile.issuer='https://cognito-idp.us-east-2.amazonaws.com/us-east-2_gfKKl0wNa';
  }else profile.issuer=`https://cognito-idp.us-west-2.amazonaws.com/${cloud.UserPoolId}`;
  if(profile.Enabled===false||!profile.UserAttributes.some(a=>a.Name==='email_verified'&&a.Value==='true'))throw new Error('A verified, enabled Cognito developer account is required.');
}
await mkdir('.local/dev',{recursive:true,mode:0o700});
let settings;
try{settings=JSON.parse(await readFile('.local/dev/settings.json','utf8'));}
catch(error){if(error.code!=='ENOENT')throw error;settings=Object.fromEntries(['databasePassword','restSecret','appSecret','parserSecret'].map(key=>[key,randomBytes(32).toString('hex')]));await writeFile('.local/dev/settings.json',JSON.stringify(settings),{mode:0o600});}
const writeEnv=async(path,values)=>{await writeFile(path,Object.entries(values).map(([key,value])=>`${key}=${value}`).join('\n')+'\n',{mode:0o600});};
await writeEnv('.local/dev/database.env',{POSTGRES_USER:'postgres',POSTGRES_DB:'cortex',POSTGRES_PASSWORD:settings.databasePassword});
await writeEnv('.local/dev/postgrest.env',{PGRST_DB_URI:`postgresql://cortex_postgrest:${settings.databasePassword}@postgres:5432/cortex`,PGRST_DB_SCHEMAS:'public',PGRST_DB_EXTRA_SEARCH_PATH:'extensions',PGRST_DB_CONFIG:'false',PGRST_JWT_SECRET:settings.restSecret,PGRST_JWT_AUD:'cortex:database',PGRST_JWT_ROLE_CLAIM_KEY:'$.role',PGRST_OPENAPI_MODE:'disabled'});
await writeEnv('.local/dev/parser.env',{PARSER_SECRET:settings.parserSecret});
if(spawnSync('docker',['compose','up','-d','--wait','postgres'],{stdio:'inherit'}).status!==0)throw new Error('Local database startup failed.');
const client=new pg.Client({host:'127.0.0.1',port:5433,database:'cortex',user:'postgres',password:settings.databasePassword});
await client.connect();
try{
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('cortex-local-migrations'))");
  const exists=await client.query("SELECT to_regclass('public.documents') AS documents");
  if(!exists.rows[0].documents){
    await client.query("CREATE ROLE cortex_backend NOLOGIN NOINHERIT; CREATE ROLE cortex_postgrest LOGIN NOINHERIT;");
    await client.query(await readFile('database/migrations/0000_baseline.sql','utf8'));
    const signature=await schemaSignature(client),expected=JSON.parse(await readFile('database/baseline-manifest.json','utf8'));
    if(signature.sha256!==expected.sha256)throw new Error('Fresh local schema does not match the source baseline.');
  }
  await client.query(`ALTER ROLE cortex_postgrest PASSWORD '${settings.databasePassword}'`);
  await client.query(await readFile('database/migrations/0001_queue_ingestion.sql','utf8'));
  await client.query(await readFile('database/migrations/0002_service_permissions.sql','utf8'));
  const org='10000000-0000-4000-8000-000000000001',namespace='10000000-0000-4000-8000-000000000002',role='10000000-0000-4000-8000-000000000003',user='10000000-0000-4000-8000-000000000004';
  await client.query("INSERT INTO public.role(id,name) VALUES($1,'super_admin') ON CONFLICT(id) DO NOTHING",[role]);
  await client.query("INSERT INTO public.organization(id,name,chat_retention_days) VALUES($1,'Synthetic local development',0) ON CONFLICT(id) DO NOTHING",[org]);
  await client.query("INSERT INTO public.namespace(id,name,organization_id) VALUES($1,'local',$2) ON CONFLICT(id) DO NOTHING",[namespace,org]);
  await client.query("INSERT INTO public.\"user\"(id,email,role_id,organization_id) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET email=excluded.email",[user,email||'local-fixture@example.invalid',role,org]);
  await client.query("INSERT INTO public.namespace_users(user_id,namespace_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[user,namespace]);
  if(profile){const subject=profile.UserAttributes.find(a=>a.Name==='sub').Value;await client.query("INSERT INTO public.auth_identities(provider,issuer,subject,user_id) VALUES('cognito',$1,$2,$3) ON CONFLICT(provider,issuer,subject) DO NOTHING",[profile.issuer,subject,user]);}
  await client.query("NOTIFY pgrst,'reload schema'");
  await client.query('COMMIT');
}catch(error){await client.query('ROLLBACK');throw error;}
finally{await client.end();}
if(spawnSync('docker',['compose','up','-d','--wait','postgrest'],{stdio:'inherit'}).status!==0)throw new Error('Local database API startup failed.');
if(cloud){
  const cognito=aws(['cognito-idp','describe-user-pool-client','--user-pool-id',cloud.UserPoolId,'--client-id',cloud.UserPoolClientId]);
  const key=aws(['secretsmanager','get-secret-value','--secret-id',cloud.OpenAiSecret]).SecretString;
  await writeEnv('.local/dev/app.env',{CORTEX_ENV:'local',BACKEND_PROVIDER:'aws',PORT:'8082',AWS_REGION:'us-west-2',RDS_REST_URL:'http://127.0.0.1:3004',RDS_REST_JWT_SECRET:settings.restSecret,AWS_CORTEX_JWT_SECRET:settings.appSecret,COGNITO_USER_POOL_ID:cloud.UserPoolId,COGNITO_CLIENT_ID:cloud.UserPoolClientId,COGNITO_CLIENT_SECRET:cognito.UserPoolClient.ClientSecret,COGNITO_LEGACY_ISSUER:'https://cognito-idp.us-east-2.amazonaws.com/us-east-2_gfKKl0wNa',PARSER_URL:'http://127.0.0.1:8091',PARSER_SECRET:settings.parserSecret,OPENAI_API_KEY:key,INGEST_WORKER:'on',RETENTION_SWEEP_MINUTES:'0',S3_DOCUMENTS_BUCKET:''});
}
console.log(databaseOnly?'Local schema and synthetic identity fixture are ready. No AWS services were used.':'Local setup ready. Run npm run dev:local. Credentials remain in ignored files.');
