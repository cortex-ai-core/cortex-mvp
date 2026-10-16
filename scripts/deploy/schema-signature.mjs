import { createHash } from 'node:crypto';
export async function schemaSignature(client) {
  await client.query('SET search_path=public,pg_catalog');
  const columns=(await client.query(`SELECT c.relname AS table_name,a.attname AS column_name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`)).rows;
  const constraints=(await client.query(`SELECT c.relname AS table_name,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,k.conname`)).rows;
  const functions=(await client.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND NOT EXISTS(SELECT FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e') ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`)).rows;
  const indexes=(await client.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")).rows;
  const policies=(await client.query("SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname")).rows;
  const rowSecurity=(await client.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname")).rows;
  const canonical=JSON.stringify({columns,constraints,functions,indexes,policies,rowSecurity}).replace(/\\r\\n/g,'\\n');
  return {sha256:createHash('sha256').update(canonical).digest('hex'),tables:new Set(columns.map(c=>c.table_name)).size,functions:functions.length};
}
