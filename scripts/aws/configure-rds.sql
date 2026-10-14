-- Run as the RDS administrator, inside one transaction. No Supabase access.
SELECT pg_advisory_xact_lock(hashtext('cortex-aws-backend-setup'));
DO $$
BEGIN
  IF current_database() <> 'cortex' OR current_setting('server_version_num')::integer < 180000 THEN
    RAISE EXCEPTION 'Expected the cortex PostgreSQL 18 database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM migration.restore_metadata
    WHERE archive_sha256 = 'D23B44EF40D236E764E1E6D8DEF6E7F81A8CF6DB18DB4DE0C73B761FC18EE3BA') THEN
    RAISE EXCEPTION 'Expected the verified application snapshot';
  END IF;
  IF to_regclass('public.auth_identities') IS NULL THEN
    RAISE EXCEPTION 'Link the Cognito test identity before configuring backend access';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cortex_backend') THEN
    CREATE ROLE cortex_backend NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cortex_postgrest') THEN
    CREATE ROLE cortex_postgrest LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('cortex_backend', 'cortex_postgrest')
    AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Backend roles unexpectedly have administrative privileges';
  END IF;
END;
$$;
GRANT CONNECT ON DATABASE cortex TO cortex_postgrest;
GRANT cortex_backend TO cortex_postgrest WITH INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA public, extensions TO cortex_backend;
ALTER ROLE cortex_backend SET statement_timeout = '30s';

-- This is a server-only service role, like the existing Supabase service key.
-- The API's existing role, organization and namespace guards authorize callers.
-- No DDL, TRUNCATE, source-secret access, or access to the migration schema.
DO $$
DECLARE
  table_name text;
  function_signature text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'messages','documents','attestations','conversation_archives','conversation_summaries',
    'conversations','document_chunks','document_types','ingest_events','memories',
    'memory_events','memory_settings','memory_state_basis','memory_states','namespace',
    'namespace_users','organization','pcl','personas','rag_queries','role','user','user_settings','auth_identities'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO cortex_backend', table_name);
    IF EXISTS (SELECT FROM pg_class WHERE oid = format('public.%I', table_name)::regclass AND relrowsecurity) THEN
      IF NOT EXISTS (SELECT FROM pg_policy WHERE polrelid = format('public.%I', table_name)::regclass
        AND polname = 'cortex_backend_service') THEN
        EXECUTE format('CREATE POLICY cortex_backend_service ON public.%I TO cortex_backend USING (true) WITH CHECK (true)', table_name);
      END IF;
    END IF;
  END LOOP;
  FOR function_signature IN
    SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname = 'public' AND p.proname IN (
      'append_message','archive_conversation','claim_next_document','hybrid_search',
      'match_document_profiles','match_documents','match_memories','reset_stale_ingests',
      'search_memories_keyword','touch_memories'
    )) OR EXISTS (
      SELECT FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
        AND e.extname IN ('vector', 'btree_gist', 'pgcrypto', 'uuid-ossp')
    )
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO cortex_backend', function_signature);
  END LOOP;
END;
$$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cortex_backend;
REVOKE ALL ON public.cortex_secrets FROM cortex_backend, cortex_postgrest;
NOTIFY pgrst, 'reload schema';
