-- Claim one queued document atomically. Duplicate deliveries must not run a second parser.
CREATE OR REPLACE FUNCTION public.claim_document(p_document_id uuid)
RETURNS SETOF public.documents LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  UPDATE public.documents SET status='parsing',attempts=attempts+1,
    stage_progress=0,stage_detail=NULL,error=NULL,heartbeat_at=now()
  WHERE id=(SELECT id FROM public.documents WHERE id=p_document_id
    AND status='queued' AND attempts<3 FOR UPDATE SKIP LOCKED)
  RETURNING *;
$$;
REVOKE ALL ON FUNCTION public.claim_document(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_document(uuid) TO cortex_backend;
