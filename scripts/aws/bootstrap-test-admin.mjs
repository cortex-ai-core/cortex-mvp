import { pathToFileURL } from 'node:url';

export const bootstrapRoles = ['super_admin', 'admin', 'operator', 'viewer', 'client'];
const account = '223323955607';
const pool = 'us-west-2_jkRHTdgKB';
const issuer = `https://cognito-idp.us-west-2.amazonaws.com/${pool}`;

export function bootstrapConfiguration(env) {
  if (env.AWS_REGION !== 'us-west-2' || env.CORTEX_ACCOUNT_ID !== account
      || env.PGHOST !== 'cortex-test-oregon.cp6g8aywalrw.us-west-2.rds.amazonaws.com'
      || env.PGDATABASE !== 'cortex'
      || env.MIGRATION_BUCKET !== 'cortex-migration-test-223323955607-us-west-2'
      || env.BOOTSTRAP_USER_POOL_ID !== pool) throw new Error('Bootstrap is restricted to the deployed Test database and pool.');
  const { BOOTSTRAP_MODE: mode, BOOTSTRAP_EMAIL: email, BOOTSTRAP_SUBJECT: subject,
    BOOTSTRAP_ORGANIZATION: organization, BOOTSTRAP_WORKSPACE: workspace, BOOTSTRAP_RUN_ID: runId } = env;
  if (!['preflight', 'apply', 'verify'].includes(mode)
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '') || email !== email.toLowerCase()
      || !organization?.trim() || !workspace?.trim()
      || !/^[a-f0-9-]{36}$/.test(runId || '')
      || (mode !== 'preflight' && !/^[a-f0-9-]{36}$/.test(subject || ''))) throw new Error('Invalid bootstrap inputs.');
  return { mode, email, subject, organization, workspace, runId };
}

export function validateBootstrapState(counts, identity, roles, config) {
  const required = ['role', 'organization', 'namespace', 'user', 'namespace_users', 'auth_identities'];
  if (required.some(name => !Number.isSafeInteger(counts[name]))
      || Object.values(counts).some(count => !Number.isSafeInteger(count) || count < 0)) throw new Error('Invalid database inventory.');
  if (Object.values(counts).every(count => count === 0)) {
    if (config.mode === 'verify') throw new Error('Bootstrap has not been applied.');
    return 'empty';
  }
  const expected = { role: 5, organization: 1, namespace: 1, user: 1, namespace_users: 1, auth_identities: 1 };
  const exactCounts = Object.entries(counts).every(([name, count]) => count === (expected[name] || 0));
  const exactRoles = [...roles].sort().join(',') === [...bootstrapRoles].sort().join(',');
  const exactIdentity = identity?.email === config.email && identity.active === true
    && identity.role === 'super_admin' && identity.organization === config.organization
    && identity.workspace === config.workspace && identity.provider === 'cognito'
    && identity.issuer === issuer && identity.subject === config.subject;
  if (config.mode === 'preflight' || !exactCounts || !exactRoles || !exactIdentity) {
    throw new Error('Existing Test data differs from the exact initial admin setup; refusing to modify it.');
  }
  return 'already-configured';
}

export async function bootstrapTestAdmin(env = process.env) {
  const config = bootstrapConfiguration(env);
  const [{ default: pg }, { readFile }, { STSClient, GetCallerIdentityCommand }, { S3Client, PutObjectCommand }] = await Promise.all([
    import('pg'), import('node:fs/promises'), import('@aws-sdk/client-sts'), import('@aws-sdk/client-s3'),
  ]);
  const sts = new STSClient({ region: 'us-west-2' });
  try {
    if ((await sts.send(new GetCallerIdentityCommand({}))).Account !== account) throw new Error('AWS account mismatch.');
  } finally { sts.destroy(); }
  const client = new pg.Client({ host: env.PGHOST, database: env.PGDATABASE, user: env.PGUSER,
    password: env.PGPASSWORD, ssl: { ca: await readFile(env.PGSSLROOTCERT, 'utf8'), rejectUnauthorized: true } });
  await client.connect();
  const inventory = async () => {
    const { rows: tables } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    const counts = {};
    for (const { tablename } of tables) counts[tablename] = Number((await client.query(`SELECT count(*) AS count FROM public."${tablename.replaceAll('"', '""')}"`)).rows[0].count);
    const roles = (await client.query('SELECT name FROM public.role ORDER BY name')).rows.map(row => row.name);
    const identities = (await client.query(`SELECT u.id AS user_id,u.email,u.active,r.name AS role,
      o.id AS organization_id,o.name AS organization,n.id AS namespace_id,n.name AS workspace,
      a.provider,a.issuer,a.subject FROM public."user" u
      JOIN public.role r ON r.id=u.role_id JOIN public.organization o ON o.id=u.organization_id
      JOIN public.namespace_users m ON m.user_id=u.id JOIN public.namespace n ON n.id=m.namespace_id AND n.organization_id=o.id
      JOIN public.auth_identities a ON a.user_id=u.id`)).rows;
    return { counts, roles, identity: identities.length === 1 ? identities[0] : null };
  };
  let report;
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('cortex-schema-migrations'))");
    const before = await inventory();
    const state = validateBootstrapState(before.counts, before.identity, before.roles, config);
    if (config.mode === 'apply' && state === 'empty') {
      let superAdminRole;
      for (const name of bootstrapRoles) {
        const role = (await client.query('INSERT INTO public.role(name) VALUES($1) RETURNING id', [name])).rows[0];
        if (name === 'super_admin') superAdminRole = role.id;
      }
      const organization = (await client.query('INSERT INTO public.organization(name) VALUES($1) RETURNING id', [config.organization])).rows[0].id;
      const namespace = (await client.query('INSERT INTO public.namespace(name,organization_id) VALUES($1,$2) RETURNING id', [config.workspace, organization])).rows[0].id;
      const user = (await client.query('INSERT INTO public."user"(email,role_id,organization_id,active) VALUES($1,$2,$3,true) RETURNING id', [config.email, superAdminRole, organization])).rows[0].id;
      await client.query('INSERT INTO public.namespace_users(namespace_id,user_id) VALUES($1,$2)', [namespace, user]);
      await client.query("INSERT INTO public.auth_identities(provider,issuer,subject,user_id) VALUES('cognito',$1,$2,$3)", [issuer, config.subject, user]);
      await client.query("NOTIFY pgrst,'reload schema'");
    }
    const after = await inventory();
    if (config.mode !== 'preflight') validateBootstrapState(after.counts, after.identity, after.roles, { ...config, mode: 'verify' });
    await client.query('COMMIT');
    report = { account, region: 'us-west-2', userPoolId: pool, at: new Date().toISOString(), mode: config.mode,
      state: config.mode === 'apply' && state === 'empty' ? 'created' : state,
      counts: after.counts, roles: after.roles, identity: after.identity };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { await client.end(); }
  const s3 = new S3Client({ region: 'us-west-2' });
  try {
    await s3.send(new PutObjectCommand({ Bucket: env.MIGRATION_BUCKET,
      Key: `bootstrap/reports/${config.runId}/${config.mode}.json`, Body: JSON.stringify(report, null, 2), ContentType: 'application/json' }));
  } finally { s3.destroy(); }
  console.log(JSON.stringify(report));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await bootstrapTestAdmin();
