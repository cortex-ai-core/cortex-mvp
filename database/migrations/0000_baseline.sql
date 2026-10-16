CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA "public";
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public";
--
-- PostgreSQL database dump
--


-- Dumped from database version 18.3
-- Dumped by pg_dump version 18.6 (Debian 18.6-1.pgdg12+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: extensions; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS extensions;


--
-- Name: migration; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS migration;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    seq integer NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    mode text,
    citations jsonb,
    sources jsonb,
    memory_ids uuid[],
    token_estimate integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])))
);


--
-- Name: append_message(uuid, uuid, uuid, uuid, text, text, text, jsonb, jsonb, uuid[], integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.append_message(p_conversation_id uuid, p_organization_id uuid, p_namespace_id uuid, p_user_id uuid, p_role text, p_content text, p_mode text DEFAULT NULL::text, p_citations jsonb DEFAULT NULL::jsonb, p_sources jsonb DEFAULT NULL::jsonb, p_memory_ids uuid[] DEFAULT NULL::uuid[], p_token_estimate integer DEFAULT NULL::integer) RETURNS public.messages
    LANGUAGE plpgsql
    AS $$
declare
  next_seq integer;
  m public.messages;
begin
  update public.conversations
     set message_count   = message_count + 1,
         last_message_at = now()
   where id = p_conversation_id
     and organization_id = p_organization_id
     and namespace_id    = p_namespace_id
     and user_id         = p_user_id
     and archived_at is null
  returning message_count into next_seq;

  if next_seq is null then
    raise exception 'conversation % not found for this owner or archived', p_conversation_id
      using errcode = 'P0002';
  end if;

  insert into public.messages
    (conversation_id, organization_id, namespace_id, user_id, seq, role, content, mode,
     citations, sources, memory_ids, token_estimate)
  values
    (p_conversation_id, p_organization_id, p_namespace_id, p_user_id, next_seq, p_role, p_content, p_mode,
     p_citations, p_sources, p_memory_ids, p_token_estimate)
  returning * into m;

  return m;
end
$$;


--
-- Name: archive_conversation(uuid, jsonb, text, text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.archive_conversation(p_id uuid, p_archive jsonb, p_summary_text text, p_model text DEFAULT NULL::text, p_prompt_version text DEFAULT NULL::text, p_fallback boolean DEFAULT false) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare
  c public.conversations;
  n integer;
begin
  select * into c
    from public.conversations
   where id = p_id
     and archived_at is null
     and legal_hold = false
     and not exists (select 1 from public.organization o where o.id = conversations.organization_id and o.retention_hold)
   for update;
  if not found then
    return null;
  end if;

  insert into public.conversation_archives
    (conversation_id, organization_id, namespace_id, user_id, title,
     summary, summary_text, started_at, ended_at, message_count,
     model, prompt_version, fallback)
  values
    (c.id, c.organization_id, c.namespace_id, c.user_id, c.title,
     coalesce(p_archive, '{}'::jsonb), coalesce(p_summary_text, ''), c.created_at, c.last_message_at, c.message_count,
     p_model, p_prompt_version, coalesce(p_fallback, false));

  delete from public.messages where conversation_id = c.id;
  get diagnostics n = row_count;

  delete from public.conversation_summaries where conversation_id = c.id;

  update public.memories
     set source_purged_at = now()
   where source_conversation_id = c.id
     and source_purged_at is null;

  update public.conversations
     set archived_at = now(),
         purged_at   = now()
   where id = c.id;

  return n;
end
$$;


--
-- Name: FUNCTION archive_conversation(p_id uuid, p_archive jsonb, p_summary_text text, p_model text, p_prompt_version text, p_fallback boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.archive_conversation(p_id uuid, p_archive jsonb, p_summary_text text, p_model text, p_prompt_version text, p_fallback boolean) IS 'Retention: insert the structured archive, purge messages and running summary, stamp memories and the thread. Null = nothing to do.';


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    metadata jsonb DEFAULT '{}'::jsonb,
    user_id uuid,
    storage_path text,
    mime_type text,
    uploaded_at timestamp with time zone DEFAULT now(),
    status text DEFAULT 'ready'::text NOT NULL,
    stage_progress integer DEFAULT 0 NOT NULL,
    stage_detail text,
    error text,
    sha256 text,
    byte_size bigint,
    page_count integer,
    parser text DEFAULT 'legacy'::text NOT NULL,
    parser_version text,
    uploaded_by text,
    attempts integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    display_name text,
    document_type text,
    description text,
    rendition_path text,
    heartbeat_at timestamp with time zone,
    profile_text text,
    embedding public.vector(1536),
    embedded_at timestamp with time zone,
    namespace_id uuid NOT NULL,
    CONSTRAINT documents_parser_check CHECK ((parser = ANY (ARRAY['legacy'::text, 'docling'::text]))),
    CONSTRAINT documents_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'parsing'::text, 'structuring'::text, 'learning'::text, 'ready'::text, 'failed'::text])))
);


--
-- Name: claim_next_document(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_next_document() RETURNS SETOF public.documents
    LANGUAGE sql
    AS $$
  update public.documents
     set status = 'parsing',
         attempts = attempts + 1,
         stage_progress = 0,
         stage_detail = null,
         error = null,
         heartbeat_at = now()
   where id = (
     select id from public.documents
      where status = 'queued'
      order by created_at
      limit 1
      for update skip locked
   )
  returning *;
$$;


--
-- Name: hybrid_search(text, public.vector, uuid, integer, integer, double precision, double precision, integer, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hybrid_search(query_text text, query_embedding public.vector, query_namespace_id uuid, match_count integer DEFAULT 12, per_document_cap integer DEFAULT 3, semantic_weight double precision DEFAULT 1.0, keyword_weight double precision DEFAULT 1.0, rrf_k integer DEFAULT 60, filter_document_ids uuid[] DEFAULT NULL::uuid[]) RETURNS TABLE(chunk_id uuid, document_id uuid, file_name text, display_name text, chunk_index integer, chunk_text text, page_start integer, page_end integer, section_label text, item_kind text, semantic_rank integer, keyword_rank integer, similarity double precision, score double precision)
    LANGUAGE sql STABLE
    SET "hnsw.ef_search" TO '120'
    AS $$
with pool as (
  select least(greatest(match_count * 4, 20), 80) as n
),
semantic as (
  select s.id,
         s.sim,
         row_number() over (order by s.dist asc, s.id asc) as rnk
    from (
      select c.id,
             c.embedding <=> query_embedding        as dist,
             1 - (c.embedding <=> query_embedding)  as sim
        from public.document_chunks c
        join public.documents d on d.id = c.document_id
       where c.namespace_id = query_namespace_id
         and c.embedding is not null
         and d.status = 'ready'
         and (filter_document_ids is null or c.document_id = any(filter_document_ids))
       order by c.embedding <=> query_embedding
       limit (select n from pool)
    ) s
),
keyword as (
  select k.id,
         row_number() over (order by k.rank desc, k.id asc) as rnk
    from (
      select c.id,
             ts_rank_cd(c.tsv, q) as rank
        from public.document_chunks c
        join public.documents d on d.id = c.document_id
       cross join websearch_to_tsquery('english', query_text) q
       where c.namespace_id = query_namespace_id
         and d.status = 'ready'
         and c.tsv @@ q
         and (filter_document_ids is null or c.document_id = any(filter_document_ids))
       order by ts_rank_cd(c.tsv, q) desc
       limit (select n from pool)
    ) k
),
fused as (
  select coalesce(s.id, k.id) as id,
         s.rnk                as srank,
         k.rnk                as krank,
         s.sim                as sim,
         coalesce(semantic_weight / (rrf_k + s.rnk), 0)
       + coalesce(keyword_weight  / (rrf_k + k.rnk), 0) as score
    from semantic s
    full outer join keyword k on s.id = k.id
),
capped as (
  select f.id, f.srank, f.krank, f.sim, f.score,
         c.document_id,
         row_number() over (
           partition by c.document_id
           order by f.score desc, c.chunk_index asc, c.id asc
         ) as doc_rank
    from fused f
    join public.document_chunks c on c.id = f.id
)
select c.id,
       c.document_id,
       d.file_name,
       d.display_name,
       c.chunk_index,
       c.chunk_text,
       c.page_start,
       c.page_end,
       c.section_label,
       c.item_kind,
       x.srank::integer,
       x.krank::integer,
       x.sim,
       x.score
  from capped x
  join public.document_chunks c on c.id = x.id
  join public.documents d on d.id = c.document_id
 where x.doc_rank <= per_document_cap
 order by x.score desc, c.chunk_index asc, c.id asc
 limit match_count;
$$;


--
-- Name: match_document_profiles(public.vector, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_document_profiles(query_embedding public.vector, query_namespace_id uuid, match_count integer DEFAULT 10) RETURNS TABLE(id uuid, file_name text, display_name text, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
  select d.id,
         d.file_name,
         d.display_name,
         (1 - (d.embedding <=> query_embedding))::double precision as similarity
    from public.documents d
   where d.namespace_id = query_namespace_id
     and d.status = 'ready'
     and d.embedding is not null
   order by d.embedding <=> query_embedding
   limit match_count;
$$;


--
-- Name: match_documents(public.vector, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_documents(query_embedding public.vector, similarity_threshold double precision, match_count integer) RETURNS TABLE(id uuid, document_id uuid, chunk_index integer, chunk_text text, similarity double precision)
    LANGUAGE plpgsql
    AS $$
begin
  return query
  select
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.chunk_text,
    1 - (dc.embedding <=> query_embedding) as similarity
  from document_chunks dc
  where (1 - (dc.embedding <=> query_embedding)) > similarity_threshold
  order by similarity desc
  limit match_count;
end;
$$;


--
-- Name: match_documents(public.vector, double precision, integer, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_documents(query_embedding public.vector, match_threshold double precision, match_count integer, query_namespace_id uuid) RETURNS TABLE(id uuid, chunk_text text, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
  select
    c.id,
    c.chunk_text,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.document_chunks c
  where c.namespace_id = query_namespace_id
    and c.embedding is not null
    and 1 - (c.embedding <=> query_embedding) > match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
$$;


--
-- Name: match_memories(public.vector, uuid, uuid, uuid, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_memories(query_embedding public.vector, query_organization_id uuid, query_namespace_id uuid, query_user_id uuid, match_count integer DEFAULT 20, include_shared boolean DEFAULT true) RETURNS TABLE(id uuid, scope text, kind text, content text, importance smallint, access_count integer, last_accessed_at timestamp with time zone, created_at timestamp with time zone, truth_status text, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
  select m.id, m.scope, m.kind, m.content, m.importance,
         m.access_count, m.last_accessed_at, m.created_at, m.truth_status,
         (1 - (m.embedding <=> query_embedding))::double precision as similarity
    from public.memories m
   where m.organization_id = query_organization_id
     and m.namespace_id    = query_namespace_id
     and m.status = 'active'
     and m.truth_status in ('accepted','contested','reported')
     and m.embedding is not null
     and (m.expires_at is null or m.expires_at > now())
     and (
       (m.scope = 'user' and m.user_id = query_user_id)
       or (include_shared and m.scope = 'namespace')
     )
   order by m.embedding <=> query_embedding
   limit match_count;
$$;


--
-- Name: reset_stale_ingests(interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reset_stale_ingests(older_than interval DEFAULT '00:02:00'::interval) RETURNS integer
    LANGUAGE sql
    AS $$
  with stale as (
    select id, attempts
      from public.documents
     where status in ('parsing', 'structuring', 'learning')
       and coalesce(heartbeat_at, updated_at) < now() - older_than
       for update skip locked
  ),
  requeued as (
    update public.documents d
       set status = 'queued',
           stage_progress = 0,
           stage_detail = 'Waiting to be read',
           heartbeat_at = null
      from stale s
     where d.id = s.id
       and s.attempts < 3
    returning d.id
  ),
  gave_up as (
    update public.documents d
       set status = 'failed',
           error = 'Gave up after 3 attempts (worker stopped mid-ingest)',
           stage_detail = null,
           heartbeat_at = null
      from stale s
     where d.id = s.id
       and s.attempts >= 3
    returning d.id
  ),
  -- never leave a half-embedded document behind (mirrors failDocument in worker.js)
  cleared as (
    delete from public.document_chunks c
     using gave_up g
     where c.document_id = g.id
    returning c.id
  )
  select (select count(*) from requeued)::integer
       + (select count(*) from gave_up)::integer;
$$;


--
-- Name: search_memories_keyword(text, uuid, uuid, uuid, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_memories_keyword(query_text text, query_organization_id uuid, query_namespace_id uuid, query_user_id uuid, match_count integer DEFAULT 10, include_shared boolean DEFAULT true) RETURNS TABLE(id uuid, rank real)
    LANGUAGE sql STABLE
    AS $$
  select m.id, ts_rank_cd(m.tsv, websearch_to_tsquery('english', query_text)) as rank
    from public.memories m
   where m.organization_id = query_organization_id
     and m.namespace_id    = query_namespace_id
     and m.status = 'active'
     and m.truth_status in ('accepted','contested','reported')
     and (m.expires_at is null or m.expires_at > now())
     and m.tsv @@ websearch_to_tsquery('english', query_text)
     and (
       (m.scope = 'user' and m.user_id = query_user_id)
       or (include_shared and m.scope = 'namespace')
     )
   order by rank desc
   limit match_count;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end $$;


--
-- Name: set_user_settings_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_user_settings_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


--
-- Name: touch_memories(uuid[], uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_memories(p_ids uuid[], p_organization_id uuid, p_namespace_id uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare n integer;
begin
  update public.memories
     set access_count = access_count + 1,
         last_accessed_at = now()
   where id = any (p_ids)
     and organization_id = p_organization_id
     and namespace_id = p_namespace_id
     and status = 'active';
  get diagnostics n = row_count;
  return n;
end;
$$;


--
-- Name: update_chat_sessions_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_chat_sessions_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  update chat_sessions
  set updated_at = now()
  where id = new.session_id;
  return new;
end;
$$;


--
-- Name: legacy_auth_ids; Type: TABLE; Schema: migration; Owner: -
--

CREATE TABLE migration.legacy_auth_ids (
    id uuid NOT NULL,
    source text DEFAULT 'supabase'::text NOT NULL,
    CONSTRAINT legacy_auth_ids_source_check CHECK ((source = 'supabase'::text))
);


--
-- Name: TABLE legacy_auth_ids; Type: COMMENT; Schema: migration; Owner: -
--

COMMENT ON TABLE migration.legacy_auth_ids IS 'Supabase Auth IDs referenced in the application snapshot. No credentials or login accounts. Preserve during Cognito identity mapping.';


--
-- Name: restore_metadata; Type: TABLE; Schema: migration; Owner: -
--

CREATE TABLE migration.restore_metadata (
    archive_sha256 text NOT NULL,
    restored_at timestamp with time zone DEFAULT now() NOT NULL,
    description text NOT NULL
);


--
-- Name: attestations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attestations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    memory_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    stance text NOT NULL,
    strength text DEFAULT 'direct_statement'::text NOT NULL,
    source_layer text NOT NULL,
    source_ref jsonb,
    authority_score real NOT NULL,
    confidence real DEFAULT 1.0 NOT NULL,
    extraction_method text DEFAULT 'user'::text NOT NULL,
    first_party boolean,
    self_serving boolean,
    status text DEFAULT 'accepted'::text NOT NULL,
    actor text,
    asserted_at timestamp with time zone DEFAULT now() NOT NULL,
    invalidated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attestations_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
    CONSTRAINT attestations_source_layer_check CHECK ((source_layer = ANY (ARRAY['knowledge'::text, 'user_explicit'::text, 'admin'::text, 'extracted'::text, 'current_context'::text, 'history'::text]))),
    CONSTRAINT attestations_stance_check CHECK ((stance = ANY (ARRAY['asserts'::text, 'denies'::text, 'reports'::text, 'questions'::text, 'conditions'::text, 'derived'::text]))),
    CONSTRAINT attestations_status_check CHECK ((status = ANY (ARRAY['candidate'::text, 'accepted'::text, 'rejected'::text, 'quarantined'::text]))),
    CONSTRAINT attestations_strength_check CHECK ((strength = ANY (ARRAY['direct_statement'::text, 'allegation'::text, 'inference'::text, 'observation'::text, 'measurement'::text, 'computation'::text, 'expert_judgment'::text])))
);


--
-- Name: auth_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_identities (
    provider text NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    user_id uuid NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT auth_identities_provider_check CHECK ((provider = 'cognito'::text))
);


--
-- Name: TABLE auth_identities; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.auth_identities IS 'Explicit administrator-provisioned external identity links. Runtime login resolves a verified issuer and subject, never auto-links by email.';


--
-- Name: conversation_archives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_archives (
    conversation_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    title text,
    summary jsonb NOT NULL,
    summary_text text NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    message_count integer DEFAULT 0 NOT NULL,
    model text,
    prompt_version text,
    fallback boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE conversation_archives; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.conversation_archives IS 'Structured, minimised summary of a conversation whose raw messages were purged by retention. Read by people; not embedded or recalled (R-5).';


--
-- Name: conversation_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_summaries (
    conversation_id uuid NOT NULL,
    summary text NOT NULL,
    through_seq integer NOT NULL,
    token_estimate integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    title text,
    message_count integer DEFAULT 0 NOT NULL,
    last_message_at timestamp with time zone,
    archived_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    purged_at timestamp with time zone,
    legal_hold boolean DEFAULT false NOT NULL,
    legal_hold_reason text,
    legal_hold_by uuid,
    legal_hold_at timestamp with time zone
);


--
-- Name: COLUMN conversations.archived_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.conversations.archived_at IS 'When the thread was summarised into conversation_archives and its messages purged. Null = active.';


--
-- Name: COLUMN conversations.legal_hold; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.conversations.legal_hold IS 'True freezes this thread: the sweep skips it and the owner cannot delete it.';


--
-- Name: cortex_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cortex_secrets (
    key text NOT NULL,
    value text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: document_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid,
    chunk_index integer NOT NULL,
    chunk_text text NOT NULL,
    embedding public.vector(1536),
    created_at timestamp with time zone DEFAULT now(),
    metadata jsonb DEFAULT '{}'::jsonb,
    page_start integer,
    page_end integer,
    bboxes jsonb,
    headings text[],
    section_label text,
    item_kind text,
    token_count integer,
    content_hash text,
    title text,
    tsv tsvector GENERATED ALWAYS AS (((setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(section_label, ''::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(chunk_text, ''::text)), 'C'::"char"))) STORED,
    namespace_id uuid NOT NULL
);


--
-- Name: document_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL
);


--
-- Name: TABLE document_types; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.document_types IS 'Document categories, one list per organization, managed by its admins and shared by every namespace. documents.document_type carries the name.';


--
-- Name: ingest_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingest_events (
    id bigint NOT NULL,
    document_id uuid NOT NULL,
    stage text NOT NULL,
    message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ingest_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ingest_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ingest_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ingest_events_id_seq OWNED BY public.ingest_events.id;


--
-- Name: memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    user_id uuid,
    scope text NOT NULL,
    kind text NOT NULL,
    content text NOT NULL,
    content_hash text NOT NULL,
    embedding public.vector(1536),
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED,
    importance smallint DEFAULT 3 NOT NULL,
    confidence real DEFAULT 1.0 NOT NULL,
    source_type text NOT NULL,
    source_conversation_id uuid,
    source_message_id uuid,
    supersedes_id uuid,
    suggested_shared boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    access_count integer DEFAULT 0 NOT NULL,
    last_accessed_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    subject text,
    predicate text,
    semantic_key text,
    truth_status text DEFAULT 'accepted'::text NOT NULL,
    superseded_at timestamp with time zone,
    source_purged_at timestamp with time zone,
    CONSTRAINT memories_content_check CHECK ((char_length(content) <= 300)),
    CONSTRAINT memories_importance_check CHECK (((importance >= 1) AND (importance <= 5))),
    CONSTRAINT memories_kind_check CHECK ((kind = ANY (ARRAY['fact'::text, 'preference'::text, 'decision'::text, 'entity'::text, 'task'::text, 'note'::text]))),
    CONSTRAINT memories_scope_check CHECK ((scope = ANY (ARRAY['user'::text, 'namespace'::text]))),
    CONSTRAINT memories_scope_owner CHECK ((((scope = 'user'::text) AND (user_id IS NOT NULL)) OR ((scope = 'namespace'::text) AND (user_id IS NULL)))),
    CONSTRAINT memories_source_type_check CHECK ((source_type = ANY (ARRAY['user_explicit'::text, 'extracted'::text, 'import'::text, 'admin'::text, 'validation'::text]))),
    CONSTRAINT memories_status_check CHECK ((status = ANY (ARRAY['active'::text, 'superseded'::text, 'archived'::text, 'deleted'::text]))),
    CONSTRAINT memories_truth_status_check CHECK ((truth_status = ANY (ARRAY['accepted'::text, 'denied'::text, 'contested'::text, 'reported'::text, 'unknown'::text, 'retracted'::text, 'superseded'::text])))
);


--
-- Name: COLUMN memories.source_purged_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.memories.source_purged_at IS 'Set when the conversation this note came from was summarised and purged, or deleted by its owner. The note itself is kept.';


--
-- Name: memory_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    memory_id uuid,
    event text NOT NULL,
    actor text,
    actor_organization_id uuid,
    target_organization_id uuid,
    target_user_id uuid,
    cross_tenant boolean DEFAULT false NOT NULL,
    reason text,
    conversation_id uuid,
    message_id uuid,
    detail jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_events_event_check CHECK ((event = ANY (ARRAY['created'::text, 'updated'::text, 'recalled'::text, 'superseded'::text, 'archived'::text, 'deleted'::text, 'blocked'::text, 'attested'::text, 'resolved'::text, 'contested'::text, 'reviewed'::text, 'admin_viewed'::text, 'admin_exported'::text, 'admin_deleted'::text, 'platform_viewed'::text, 'platform_exported'::text, 'platform_deleted'::text, 'validation'::text, 'conversation_archived'::text, 'conversation_purged'::text, 'conversation_deleted'::text, 'legal_hold_set'::text, 'legal_hold_cleared'::text, 'retention_sweep'::text])))
);


--
-- Name: memory_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_settings (
    namespace_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    memory_enabled boolean,
    history_enabled boolean,
    recall_enabled boolean,
    extract_enabled boolean,
    retention_days integer,
    max_active_per_user integer,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_settings_max_active_per_user_check CHECK (((max_active_per_user IS NULL) OR (max_active_per_user > 0))),
    CONSTRAINT memory_settings_retention_days_check CHECK (((retention_days IS NULL) OR (retention_days >= 0)))
);


--
-- Name: memory_state_basis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_state_basis (
    state_id uuid NOT NULL,
    attestation_id uuid NOT NULL,
    role text NOT NULL,
    CONSTRAINT memory_state_basis_role_check CHECK ((role = ANY (ARRAY['supporting'::text, 'contradicting'::text, 'neutral'::text])))
);


--
-- Name: memory_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    memory_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    namespace_id uuid NOT NULL,
    truth_status text NOT NULL,
    review_status text DEFAULT 'auto_computed'::text NOT NULL,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    review_note text,
    policy_version text NOT NULL,
    counterpart_id uuid,
    dimensions jsonb,
    reason text,
    basis_hash text NOT NULL,
    effective_range tstzrange DEFAULT tstzrange(now(), NULL::timestamp with time zone, '[)'::text) NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_states_review_status_check CHECK ((review_status = ANY (ARRAY['auto_computed'::text, 'human_reviewed'::text, 'needs_review'::text, 'overridden'::text]))),
    CONSTRAINT memory_states_truth_status_check CHECK ((truth_status = ANY (ARRAY['accepted'::text, 'denied'::text, 'contested'::text, 'reported'::text, 'unknown'::text, 'retracted'::text, 'superseded'::text])))
);


--
-- Name: namespace; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.namespace (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_updated_at timestamp with time zone,
    organization_id uuid NOT NULL,
    default_persona_id uuid
);


--
-- Name: COLUMN namespace.default_persona_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.namespace.default_persona_id IS 'Persona for members with no assignment of their own (spec 50, associate PCL with namespace). Null = built-in default.';


--
-- Name: namespace_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.namespace_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    namespace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: organization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    last_updated_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    description text,
    chat_retention_days integer DEFAULT 30 NOT NULL,
    retention_hold boolean DEFAULT false NOT NULL,
    retention_hold_reason text,
    CONSTRAINT organization_chat_retention_days_check CHECK ((chat_retention_days >= 0))
);


--
-- Name: COLUMN organization.chat_retention_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organization.chat_retention_days IS 'Days since a conversation''s last message before it is summarised and its raw chat purged. 0 = keep forever. memory_settings.retention_days overrides per namespace.';


--
-- Name: COLUMN organization.retention_hold; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organization.retention_hold IS 'True freezes every conversation in the organization: the sweep skips them and users cannot delete them.';


--
-- Name: pcl; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pcl (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_updated_at timestamp with time zone,
    persona_id uuid,
    version integer DEFAULT 1 NOT NULL,
    configuration jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid
);


--
-- Name: TABLE pcl; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pcl IS 'Persona configuration versions (spec 4.4, 51). Append-only: saving inserts version + 1; the highest version for a persona is in force; rollback is re-inserting an older configuration as a new version.';


--
-- Name: COLUMN pcl.configuration; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pcl.configuration IS 'Validated JSON (plan section 6): identity, response, list sections, terminology, required, prohibited, lock_style.';


--
-- Name: COLUMN pcl.created_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pcl.created_by IS 'user.id of the admin who saved this version; null for the seed.';


--
-- Name: personas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.personas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT personas_key_format CHECK ((key ~ '^[a-z][a-z0-9_]{1,63}$'::text))
);


--
-- Name: TABLE personas; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.personas IS 'Named persona definitions (spec 4.4). organization_id null = shared by every organization. Rules live in pcl, one row per version.';


--
-- Name: COLUMN personas.key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.personas.key IS 'Stable identifier used in code, logs and traces: core_executive, advisory, talent_intelligence, ...';


--
-- Name: COLUMN personas.is_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.personas.is_active IS 'A deactivated persona is skipped at resolve time (the user falls back to the namespace default, then the built-in default) and is hidden from assignment.';


--
-- Name: rag_queries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rag_queries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    query text,
    created_at timestamp with time zone DEFAULT now(),
    results jsonb,
    mode text,
    user_id text,
    latency_ms integer,
    result_count integer,
    named_documents jsonb,
    namespace_id uuid,
    conversation_id uuid,
    memory_ids uuid[],
    memory_block_tokens integer,
    history_turns integer,
    answer_mode text,
    conflicts jsonb,
    usage jsonb,
    extracted_memory_ids uuid[],
    pcl jsonb,
    text_purged_at timestamp with time zone
);


--
-- Name: COLUMN rag_queries.usage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rag_queries.usage IS 'Model calls the turn made: {calls:[{stage,model,input,output,usd}], input, output, usd}. Extraction and summariser calls are appended after the reply.';


--
-- Name: COLUMN rag_queries.extracted_memory_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rag_queries.extracted_memory_ids IS 'Memories written by automatic extraction (hook H6) from this turn.';


--
-- Name: COLUMN rag_queries.pcl; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rag_queries.pcl IS 'Which persona, version, style and note shaped this turn (plan 7.4). Null before Phase 2.';


--
-- Name: role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text,
    role_id uuid NOT NULL,
    _1 uuid,
    _2 uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    organization_id uuid,
    auth_user_id uuid,
    active boolean DEFAULT true NOT NULL
);


--
-- Name: user_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_settings (
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    personalization text,
    persona_id uuid,
    response_length text,
    CONSTRAINT user_settings_response_length_check CHECK (((response_length IS NULL) OR (response_length = ANY (ARRAY['concise'::text, 'standard'::text, 'detailed'::text]))))
);


--
-- Name: COLUMN user_settings.persona_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_settings.persona_id IS 'The persona assigned to this user (spec D.12 profile assignment). Null = use the namespace default.';


--
-- Name: COLUMN user_settings.response_length; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_settings.response_length IS 'The user''s own answer length, overriding the persona''s default when set. Null = the persona decides.';


--
-- Name: ingest_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_events ALTER COLUMN id SET DEFAULT nextval('public.ingest_events_id_seq'::regclass);


--
-- Name: legacy_auth_ids legacy_auth_ids_pkey; Type: CONSTRAINT; Schema: migration; Owner: -
--

ALTER TABLE ONLY migration.legacy_auth_ids
    ADD CONSTRAINT legacy_auth_ids_pkey PRIMARY KEY (id);


--
-- Name: restore_metadata restore_metadata_pkey; Type: CONSTRAINT; Schema: migration; Owner: -
--

ALTER TABLE ONLY migration.restore_metadata
    ADD CONSTRAINT restore_metadata_pkey PRIMARY KEY (archive_sha256);


--
-- Name: attestations attestations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attestations
    ADD CONSTRAINT attestations_pkey PRIMARY KEY (id);


--
-- Name: auth_identities auth_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_identities
    ADD CONSTRAINT auth_identities_pkey PRIMARY KEY (provider, issuer, subject);


--
-- Name: auth_identities auth_identities_user_id_provider_issuer_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_identities
    ADD CONSTRAINT auth_identities_user_id_provider_issuer_key UNIQUE (user_id, provider, issuer);


--
-- Name: conversation_archives conversation_archives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_archives
    ADD CONSTRAINT conversation_archives_pkey PRIMARY KEY (conversation_id);


--
-- Name: conversation_summaries conversation_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_summaries
    ADD CONSTRAINT conversation_summaries_pkey PRIMARY KEY (conversation_id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: cortex_secrets cortex_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cortex_secrets
    ADD CONSTRAINT cortex_secrets_pkey PRIMARY KEY (key);


--
-- Name: document_chunks document_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_chunks
    ADD CONSTRAINT document_chunks_pkey PRIMARY KEY (id);


--
-- Name: document_types document_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_types
    ADD CONSTRAINT document_types_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: ingest_events ingest_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_events
    ADD CONSTRAINT ingest_events_pkey PRIMARY KEY (id);


--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);


--
-- Name: memory_events memory_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_events
    ADD CONSTRAINT memory_events_pkey PRIMARY KEY (id);


--
-- Name: memory_settings memory_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_settings
    ADD CONSTRAINT memory_settings_pkey PRIMARY KEY (namespace_id);


--
-- Name: memory_state_basis memory_state_basis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_state_basis
    ADD CONSTRAINT memory_state_basis_pkey PRIMARY KEY (state_id, attestation_id);


--
-- Name: memory_states memory_states_memory_id_effective_range_excl; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_states
    ADD CONSTRAINT memory_states_memory_id_effective_range_excl EXCLUDE USING gist (memory_id WITH =, effective_range WITH &&);


--
-- Name: memory_states memory_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_states
    ADD CONSTRAINT memory_states_pkey PRIMARY KEY (id);


--
-- Name: messages messages_conversation_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_seq_key UNIQUE (conversation_id, seq);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: namespace namespace_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.namespace
    ADD CONSTRAINT namespace_pkey PRIMARY KEY (id);


--
-- Name: namespace_users namespace_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.namespace_users
    ADD CONSTRAINT namespace_users_pkey PRIMARY KEY (id);


--
-- Name: organization organization_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (id);


--
-- Name: pcl pcl_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcl
    ADD CONSTRAINT pcl_pkey PRIMARY KEY (id);


--
-- Name: personas personas_org_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personas
    ADD CONSTRAINT personas_org_key UNIQUE (organization_id, key);


--
-- Name: personas personas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personas
    ADD CONSTRAINT personas_pkey PRIMARY KEY (id);


--
-- Name: rag_queries rag_queries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rag_queries
    ADD CONSTRAINT rag_queries_pkey PRIMARY KEY (id);


--
-- Name: role role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role
    ADD CONSTRAINT role_pkey PRIMARY KEY (id);


--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (user_id);


--
-- Name: user users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: user users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: attestations_memory_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attestations_memory_idx ON public.attestations USING btree (memory_id, asserted_at DESC) WHERE ((status = 'accepted'::text) AND (invalidated_at IS NULL));


--
-- Name: conversation_archives_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_archives_owner_idx ON public.conversation_archives USING btree (organization_id, namespace_id, user_id, ended_at DESC);


--
-- Name: conversations_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_owner_idx ON public.conversations USING btree (organization_id, namespace_id, user_id, last_message_at DESC);


--
-- Name: conversations_retention_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_retention_idx ON public.conversations USING btree (last_message_at) WHERE ((archived_at IS NULL) AND (legal_hold = false));


--
-- Name: document_chunks_doc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_chunks_doc_idx ON public.document_chunks USING btree (document_id, chunk_index);


--
-- Name: document_chunks_document_chunk_index_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX document_chunks_document_chunk_index_key ON public.document_chunks USING btree (document_id, chunk_index);


--
-- Name: document_chunks_embedding_hnsw_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_chunks_embedding_hnsw_idx ON public.document_chunks USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: document_chunks_namespace_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_chunks_namespace_id_idx ON public.document_chunks USING btree (namespace_id);


--
-- Name: document_chunks_tsv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_chunks_tsv_idx ON public.document_chunks USING gin (tsv);


--
-- Name: document_types_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_types_organization_idx ON public.document_types USING btree (organization_id, sort_order, name);


--
-- Name: document_types_organization_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX document_types_organization_name_key ON public.document_types USING btree (organization_id, lower(name));


--
-- Name: documents_embedding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_embedding_idx ON public.documents USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: documents_namespace_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_namespace_id_idx ON public.documents USING btree (namespace_id);


--
-- Name: documents_namespace_id_sha_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX documents_namespace_id_sha_idx ON public.documents USING btree (namespace_id, sha256) WHERE (sha256 IS NOT NULL);


--
-- Name: documents_namespace_id_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_namespace_id_type_idx ON public.documents USING btree (namespace_id, document_type);


--
-- Name: documents_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_status_idx ON public.documents USING btree (status, created_at);


--
-- Name: idx_chunks_metadata; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chunks_metadata ON public.document_chunks USING gin (metadata);


--
-- Name: idx_documents_metadata; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_metadata ON public.documents USING gin (metadata);


--
-- Name: ingest_events_doc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ingest_events_doc_idx ON public.ingest_events USING btree (document_id, created_at DESC);


--
-- Name: memories_active_hash_shared_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX memories_active_hash_shared_idx ON public.memories USING btree (namespace_id, content_hash) WHERE ((status = 'active'::text) AND (user_id IS NULL));


--
-- Name: memories_active_hash_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX memories_active_hash_user_idx ON public.memories USING btree (namespace_id, user_id, content_hash) WHERE ((status = 'active'::text) AND (user_id IS NOT NULL));


--
-- Name: memories_embedding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_embedding_idx ON public.memories USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: memories_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_owner_idx ON public.memories USING btree (organization_id, namespace_id, user_id, status);


--
-- Name: memories_semantic_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_semantic_key_idx ON public.memories USING btree (namespace_id, user_id, semantic_key) WHERE (status = 'active'::text);


--
-- Name: memories_source_purged_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_source_purged_idx ON public.memories USING btree (namespace_id, user_id) WHERE (source_purged_at IS NOT NULL);


--
-- Name: memories_tsv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_tsv_idx ON public.memories USING gin (tsv);


--
-- Name: memory_events_cross_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_events_cross_tenant_idx ON public.memory_events USING btree (target_organization_id, created_at DESC) WHERE cross_tenant;


--
-- Name: memory_events_memory_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_events_memory_idx ON public.memory_events USING btree (memory_id, created_at DESC);


--
-- Name: memory_states_current_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_states_current_idx ON public.memory_states USING btree (memory_id) WHERE (upper(effective_range) IS NULL);


--
-- Name: memory_states_ns_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_states_ns_status_idx ON public.memory_states USING btree (namespace_id, truth_status) WHERE (upper(effective_range) IS NULL);


--
-- Name: messages_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_conversation_idx ON public.messages USING btree (conversation_id, seq);


--
-- Name: namespace_users_namespace_user_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX namespace_users_namespace_user_key ON public.namespace_users USING btree (namespace_id, user_id);


--
-- Name: namespace_users_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX namespace_users_user_idx ON public.namespace_users USING btree (user_id);


--
-- Name: pcl_persona_version; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pcl_persona_version ON public.pcl USING btree (persona_id, version);


--
-- Name: personas_shared_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX personas_shared_key ON public.personas USING btree (key) WHERE (organization_id IS NULL);


--
-- Name: rag_queries_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rag_queries_created_idx ON public.rag_queries USING btree (created_at DESC);


--
-- Name: rag_queries_namespace_id_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rag_queries_namespace_id_created_idx ON public.rag_queries USING btree (namespace_id, created_at DESC);


--
-- Name: role_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX role_name_key ON public.role USING btree (name);


--
-- Name: user_auth_user_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_auth_user_id_key ON public."user" USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);


--
-- Name: conversations conversations_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER conversations_set_updated_at BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: documents documents_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER documents_set_updated_at BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: user_settings user_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_settings_updated_at BEFORE UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION public.set_user_settings_updated_at();


--
-- Name: attestations attestations_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attestations
    ADD CONSTRAINT attestations_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: attestations attestations_namespace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attestations
    ADD CONSTRAINT attestations_namespace_id_fkey FOREIGN KEY (namespace_id) REFERENCES public.namespace(id);


--
-- Name: attestations attestations_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attestations
    ADD CONSTRAINT attestations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: auth_identities auth_identities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_identities
    ADD CONSTRAINT auth_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: conversation_archives conversation_archives_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_archives
    ADD CONSTRAINT conversation_archives_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: conversation_archives conversation_archives_namespace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_archives
    ADD CONSTRAINT conversation_archives_namespace_id_fkey FOREIGN KEY (namespace_id) REFERENCES public.namespace(id);


--
-- Name: conversation_archives conversation_archives_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_archives
    ADD CONSTRAINT conversation_archives_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: conversation_archives conversation_archives_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_archives
    ADD CONSTRAINT conversation_archives_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id);


--
-- Name: conversation_summaries conversation_summaries_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_summaries
    ADD CONSTRAINT conversation_summaries_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_namespace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_namespace_id_fkey FOREIGN KEY (namespace_id) REFERENCES public.namespace(id);


--
-- Name: conversations conversations_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: conversations conversations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id);


--
-- Name: document_chunks document_chunks_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_chunks
    ADD CONSTRAINT document_chunks_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_chunks document_chunks_namespace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_chunks
    ADD CONSTRAINT document_chunks_namespace_id_fkey FOREIGN KEY (namespace_id) REFERENCES public.namespace(id);


--
-- Name: document_types document_types_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_types
    ADD CONSTRAINT document_types_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: documents documents_namespace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_namespace_id_fkey FOREIGN KEY (namespace_id) REFERENCES public.namespace(id);


--
-- Name: documents documents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES migration.legacy_auth_ids(id);


--
-- Name: ingest_events ingest_events_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_events
    ADD CONSTRAINT ingest_events_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: memories memories_namespace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_namespace_id_fkey FOREIGN KEY (namespace_id) REFERENCES public.namespace(id);


--
-- Name: memories memories_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: memories memories_source_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_source_conversation_id_fkey FOREIGN KEY (source_conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;


--
-- Name: memories memories_source_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_source_message_id_fkey FOREIGN KEY (source_message_id) REFERENCES public.messages(id) ON DELETE SET NULL;


--
-- Name: memories memories_supersedes_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_supersedes_id_fkey FOREIGN KEY (supersedes_id) REFERENCES public.memories(id) ON DELETE SET NULL;


--
-- Name: memories memories_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id);


--
-- Name: memory_events memory_events_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_events
    ADD CONSTRAINT memory_events_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: memory_settings memory_settings_namespace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_settings
    ADD CONSTRAINT memory_settings_namespace_id_fkey FOREIGN KEY (namespace_id) REFERENCES public.namespace(id) ON DELETE CASCADE;


--
-- Name: memory_settings memory_settings_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_settings
    ADD CONSTRAINT memory_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: memory_state_basis memory_state_basis_attestation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_state_basis
    ADD CONSTRAINT memory_state_basis_attestation_id_fkey FOREIGN KEY (attestation_id) REFERENCES public.attestations(id) ON DELETE CASCADE;


--
-- Name: memory_state_basis memory_state_basis_state_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_state_basis
    ADD CONSTRAINT memory_state_basis_state_id_fkey FOREIGN KEY (state_id) REFERENCES public.memory_states(id) ON DELETE CASCADE;


--
-- Name: memory_states memory_states_counterpart_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_states
    ADD CONSTRAINT memory_states_counterpart_id_fkey FOREIGN KEY (counterpart_id) REFERENCES public.memories(id) ON DELETE SET NULL;


--
-- Name: memory_states memory_states_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_states
    ADD CONSTRAINT memory_states_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: namespace namespace_default_persona_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.namespace
    ADD CONSTRAINT namespace_default_persona_id_fkey FOREIGN KEY (default_persona_id) REFERENCES public.personas(id) ON DELETE SET NULL;


--
-- Name: namespace namespace_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.namespace
    ADD CONSTRAINT namespace_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: namespace_users namespace_users_namespace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.namespace_users
    ADD CONSTRAINT namespace_users_namespace_id_fkey FOREIGN KEY (namespace_id) REFERENCES public.namespace(id);


--
-- Name: namespace_users namespace_users_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.namespace_users
    ADD CONSTRAINT namespace_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id);


--
-- Name: pcl pcl_persona_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pcl
    ADD CONSTRAINT pcl_persona_id_fkey FOREIGN KEY (persona_id) REFERENCES public.personas(id) ON DELETE CASCADE;


--
-- Name: personas personas_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.personas
    ADD CONSTRAINT personas_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: user user_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES migration.legacy_auth_ids(id) ON DELETE CASCADE;


--
-- Name: user user_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id);


--
-- Name: user user_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.role(id);


--
-- Name: user_settings user_settings_persona_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_persona_id_fkey FOREIGN KEY (persona_id) REFERENCES public.personas(id) ON DELETE SET NULL;


--
-- Name: user_settings user_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: attestations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.attestations ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_identities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_identities ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_archives; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_archives ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_summaries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_summaries ENABLE ROW LEVEL SECURITY;

--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: attestations cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.attestations TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: auth_identities cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.auth_identities TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: conversation_archives cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.conversation_archives TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: conversation_summaries cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.conversation_summaries TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: conversations cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.conversations TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: documents cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.documents TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: memories cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.memories TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: memory_events cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.memory_events TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: memory_settings cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.memory_settings TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: memory_state_basis cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.memory_state_basis TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: memory_states cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.memory_states TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: messages cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.messages TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: namespace cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.namespace TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: namespace_users cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.namespace_users TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: organization cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.organization TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: pcl cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.pcl TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: personas cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.personas TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: rag_queries cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.rag_queries TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: role cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.role TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: user cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public."user" TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: user_settings cortex_backend_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cortex_backend_service ON public.user_settings TO cortex_backend USING (true) WITH CHECK (true);


--
-- Name: cortex_secrets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cortex_secrets ENABLE ROW LEVEL SECURITY;

--
-- Name: documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

--
-- Name: memories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_events ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_state_basis; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_state_basis ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_states; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_states ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: namespace; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.namespace ENABLE ROW LEVEL SECURITY;

--
-- Name: namespace_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.namespace_users ENABLE ROW LEVEL SECURITY;

--
-- Name: organization; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.organization ENABLE ROW LEVEL SECURITY;

--
-- Name: pcl; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pcl ENABLE ROW LEVEL SECURITY;

--
-- Name: personas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.personas ENABLE ROW LEVEL SECURITY;

--
-- Name: rag_queries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rag_queries ENABLE ROW LEVEL SECURITY;

--
-- Name: role; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.role ENABLE ROW LEVEL SECURITY;

--
-- Name: user; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public."user" ENABLE ROW LEVEL SECURITY;

--
-- Name: user_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


