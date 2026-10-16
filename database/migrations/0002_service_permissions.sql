GRANT CONNECT ON DATABASE cortex TO cortex_postgrest;
GRANT cortex_backend TO cortex_postgrest WITH INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA public,extensions TO cortex_backend;
ALTER ROLE cortex_backend SET statement_timeout='30s';
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['messages','documents','attestations','conversation_archives','conversation_summaries','conversations','document_chunks','document_types','ingest_events','memories','memory_events','memory_settings','memory_state_basis','memory_states','namespace','namespace_users','organization','pcl','personas','rag_queries','role','user','user_settings','auth_identities'] LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO cortex_backend',name);
  END LOOP;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO cortex_backend;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO cortex_backend;
REVOKE ALL ON public.cortex_secrets FROM cortex_backend,cortex_postgrest;
