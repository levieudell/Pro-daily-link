-- Source contract for disposable synthetic tests only. No production application.
-- Release requires a separately approved schema/cutover packet.
BEGIN;
CREATE OR REPLACE FUNCTION public.replace_tenant_policy_records(
  p_company_id uuid, p_expected_revision bigint, p_scalar_data jsonb,
  p_content_hash text, p_records jsonb, p_policy_guard jsonb
) RETURNS TABLE(revision bigint, record_count bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actual_revision bigint;
  current_scalars jsonb;
  owner_row jsonb;
  session_row jsonb;
  proof_row jsonb;
  receipt_row jsonb;
  matches bigint;
  deadline timestamptz;
  guard_deadline timestamptz;
  session_deadline timestamptz;
  proof_deadline timestamptz;
  proof_revision bigint;
  phase integer;
BEGIN
  IF p_expected_revision IS NULL OR p_expected_revision < 0 OR p_expected_revision >= 9007199254740991 THEN
    RAISE EXCEPTION 'PDL_EXPECTED_REVISION_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_policy_guard) IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_policy_guard)) <> 7
     OR p_policy_guard - ARRAY['kind','actorId','sessionHash','previewId','version','requestId','authorizedUntil'] <> '{}'::jsonb
     OR COALESCE(p_policy_guard->>'kind','') NOT IN ('preview','confirm')
     OR jsonb_typeof(p_policy_guard->'authorizedUntil') IS DISTINCT FROM 'string'
     OR COALESCE(p_policy_guard->>'actorId','') !~ '^[1-9][0-9]*$'
     OR COALESCE(p_policy_guard->>'sessionHash','') !~ '^[a-f0-9]{64}$'
     OR COALESCE(p_policy_guard->>'version','') !~ '^[a-f0-9]{64}$'
     OR COALESCE(p_policy_guard->>'previewId','') !~ '^[A-Za-z0-9_-]{8,128}$'
     OR COALESCE(p_policy_guard->>'requestId','') !~ '^[A-Za-z0-9_-]{8,128}$' THEN
    RAISE EXCEPTION 'PDL_POLICY_GUARD_REQUIRED' USING ERRCODE = '22023';
  END IF;
  SELECT tr.revision,tr.scalar_data INTO actual_revision,current_scalars
  FROM public.tenant_revisions tr WHERE tr.company_id=p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PDL_POLICY_AUTHORIZATION_REVOKED' USING ERRCODE='22023'; END IF;
  IF actual_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'PDL_REVISION_CONFLICT expected=% actual=%',p_expected_revision,actual_revision USING ERRCODE='40001';
  END IF;
  IF current_scalars#>>'{company,id}' IS DISTINCT FROM p_company_id::text
     OR p_scalar_data#>>'{company,id}' IS DISTINCT FROM p_company_id::text THEN
    RAISE EXCEPTION 'PDL_POLICY_AUTHORIZATION_REVOKED' USING ERRCODE='22023';
  END IF;
  SELECT count(*) INTO matches FROM public.tenant_records
  WHERE company_id=p_company_id AND collection='users' AND data->>'id'=p_policy_guard->>'actorId';
  IF matches <> 1 THEN RAISE EXCEPTION 'PDL_POLICY_AUTHORIZATION_REVOKED' USING ERRCODE='22023'; END IF;
  SELECT data INTO owner_row FROM public.tenant_records
  WHERE company_id=p_company_id AND collection='users' AND data->>'id'=p_policy_guard->>'actorId';
  IF owner_row->>'role' IS DISTINCT FROM 'owner' OR owner_row->>'status' IS DISTINCT FROM 'Active'
     OR COALESCE(owner_row->>'companyId',p_company_id::text) <> p_company_id::text THEN
    RAISE EXCEPTION 'PDL_POLICY_AUTHORIZATION_REVOKED' USING ERRCODE='22023';
  END IF;
  SELECT count(*) INTO matches FROM public.tenant_records
  WHERE company_id=p_company_id AND collection='sessions' AND data->>'tokenHash'=p_policy_guard->>'sessionHash';
  IF matches <> 1 THEN RAISE EXCEPTION 'PDL_POLICY_AUTHORIZATION_REVOKED' USING ERRCODE='22023'; END IF;
  SELECT data INTO session_row FROM public.tenant_records
  WHERE company_id=p_company_id AND collection='sessions' AND data->>'tokenHash'=p_policy_guard->>'sessionHash';
  IF session_row->>'userId' IS DISTINCT FROM p_policy_guard->>'actorId'
     OR session_row->>'companyId' IS DISTINCT FROM p_company_id::text THEN
    RAISE EXCEPTION 'PDL_POLICY_AUTHORIZATION_REVOKED' USING ERRCODE='22023';
  END IF;
  IF p_policy_guard->>'kind'='preview' THEN
    SELECT count(*) INTO matches FROM public.tenant_records WHERE company_id=p_company_id
    AND collection='rolePolicyPreviews' AND data->>'id'=p_policy_guard->>'previewId';
    IF matches <> 0 THEN RAISE EXCEPTION 'PDL_POLICY_GUARD_REQUIRED' USING ERRCODE='22023'; END IF;
    SELECT count(*) INTO matches FROM jsonb_to_recordset(p_records) AS item(collection text,data jsonb)
    WHERE item.collection='rolePolicyPreviews' AND item.data->>'id'=p_policy_guard->>'previewId';
    IF matches <> 1 THEN RAISE EXCEPTION 'PDL_POLICY_GUARD_REQUIRED' USING ERRCODE='22023'; END IF;
    SELECT item.data INTO proof_row FROM jsonb_to_recordset(p_records) AS item(collection text,data jsonb)
    WHERE item.collection='rolePolicyPreviews' AND item.data->>'id'=p_policy_guard->>'previewId';
    IF jsonb_typeof(proof_row->'expectedRevision') IS DISTINCT FROM 'number'
       OR COALESCE(proof_row->>'expectedRevision','') !~ '^[0-9]{1,16}$'
       OR (proof_row->>'expectedRevision')::bigint IS DISTINCT FROM actual_revision+1
       OR p_policy_guard->>'requestId' IS DISTINCT FROM p_policy_guard->>'previewId' THEN
      RAISE EXCEPTION 'PDL_POLICY_GUARD_REQUIRED' USING ERRCODE='22023';
    END IF;
  ELSE
    SELECT count(*) INTO matches FROM public.tenant_records WHERE company_id=p_company_id
    AND collection='rolePolicyPreviews' AND data->>'id'=p_policy_guard->>'previewId';
    IF matches <> 1 THEN RAISE EXCEPTION 'PDL_POLICY_GUARD_REQUIRED' USING ERRCODE='22023'; END IF;
    SELECT data INTO proof_row FROM public.tenant_records WHERE company_id=p_company_id
    AND collection='rolePolicyPreviews' AND data->>'id'=p_policy_guard->>'previewId';
    IF jsonb_typeof(proof_row->'expectedRevision') IS DISTINCT FROM 'number'
       OR COALESCE(proof_row->>'expectedRevision','') !~ '^[0-9]{1,16}$'
       OR (proof_row->>'expectedRevision')::bigint IS DISTINCT FROM actual_revision THEN
      RAISE EXCEPTION 'PDL_POLICY_GUARD_REQUIRED' USING ERRCODE='22023';
    END IF;
    SELECT count(*) INTO matches FROM public.tenant_records WHERE company_id=p_company_id
    AND collection='rolePolicyReceipts' AND (data->>'previewId'=p_policy_guard->>'previewId' OR data->>'id'=p_policy_guard->>'requestId');
    IF matches <> 0 THEN RAISE EXCEPTION 'PDL_POLICY_GUARD_REQUIRED' USING ERRCODE='22023'; END IF;
    SELECT count(*) INTO matches FROM jsonb_to_recordset(p_records) AS item(collection text,data jsonb)
    WHERE item.collection='rolePolicyReceipts' AND item.data->>'id'=p_policy_guard->>'requestId';
    IF matches <> 1 THEN RAISE EXCEPTION 'PDL_POLICY_GUARD_REQUIRED' USING ERRCODE='22023'; END IF;
    SELECT item.data INTO receipt_row FROM jsonb_to_recordset(p_records) AS item(collection text,data jsonb)
    WHERE item.collection='rolePolicyReceipts' AND item.data->>'id'=p_policy_guard->>'requestId';
    IF receipt_row->>'previewId' IS DISTINCT FROM p_policy_guard->>'previewId'
       OR receipt_row->>'version' IS DISTINCT FROM p_policy_guard->>'version'
       OR receipt_row->>'sessionHash' IS DISTINCT FROM p_policy_guard->>'sessionHash'
       OR receipt_row->>'actorId' IS DISTINCT FROM p_policy_guard->>'actorId'
       OR receipt_row->>'companyId' IS DISTINCT FROM p_company_id::text THEN
      RAISE EXCEPTION 'PDL_POLICY_GUARD_REQUIRED' USING ERRCODE='22023';
    END IF;
  END IF;
  -- Re-read authority after replacement too. NULL/invalid deadlines must never
  -- be silently omitted by PostgreSQL LEAST. Any failure rolls back the full CAS.
  FOR phase IN 0..1 LOOP
    SELECT count(*) INTO matches FROM public.tenant_records WHERE company_id=p_company_id
      AND collection='users' AND data->>'id'=p_policy_guard->>'actorId';
    IF matches <> 1 THEN RAISE EXCEPTION 'PDL_POLICY_AUTHORIZATION_REVOKED' USING ERRCODE='22023'; END IF;
    SELECT data INTO owner_row FROM public.tenant_records WHERE company_id=p_company_id
      AND collection='users' AND data->>'id'=p_policy_guard->>'actorId';
    IF owner_row->>'role' IS DISTINCT FROM 'owner' OR owner_row->>'status' IS DISTINCT FROM 'Active'
       OR COALESCE(owner_row->>'companyId',p_company_id::text) IS DISTINCT FROM p_company_id::text THEN
      RAISE EXCEPTION 'PDL_POLICY_AUTHORIZATION_REVOKED' USING ERRCODE='22023';
    END IF;
    SELECT count(*) INTO matches FROM public.tenant_records WHERE company_id=p_company_id
      AND collection='sessions' AND data->>'tokenHash'=p_policy_guard->>'sessionHash';
    IF matches <> 1 THEN RAISE EXCEPTION 'PDL_POLICY_AUTHORIZATION_REVOKED' USING ERRCODE='22023'; END IF;
    SELECT data INTO session_row FROM public.tenant_records WHERE company_id=p_company_id
      AND collection='sessions' AND data->>'tokenHash'=p_policy_guard->>'sessionHash';
    IF session_row->>'userId' IS DISTINCT FROM p_policy_guard->>'actorId'
       OR session_row->>'companyId' IS DISTINCT FROM p_company_id::text THEN
      RAISE EXCEPTION 'PDL_POLICY_AUTHORIZATION_REVOKED' USING ERRCODE='22023';
    END IF;
    IF phase=1 THEN
      SELECT count(*) INTO matches FROM public.tenant_records WHERE company_id=p_company_id
        AND collection='rolePolicyPreviews' AND data->>'id'=p_policy_guard->>'previewId';
      IF matches <> 1 THEN RAISE EXCEPTION 'PDL_POLICY_GUARD_REQUIRED' USING ERRCODE='22023'; END IF;
      SELECT data INTO proof_row FROM public.tenant_records WHERE company_id=p_company_id
        AND collection='rolePolicyPreviews' AND data->>'id'=p_policy_guard->>'previewId';
    END IF;
    IF proof_row->>'companyId' IS DISTINCT FROM p_company_id::text
       OR proof_row->>'actorId' IS DISTINCT FROM p_policy_guard->>'actorId'
       OR proof_row->>'sessionHash' IS DISTINCT FROM p_policy_guard->>'sessionHash'
       OR proof_row->>'version' IS DISTINCT FROM p_policy_guard->>'version'
       OR jsonb_typeof(proof_row->'expectedRevision') IS DISTINCT FROM 'number'
       OR COALESCE(proof_row->>'expectedRevision','') !~ '^[0-9]{1,16}$' THEN
      RAISE EXCEPTION 'PDL_POLICY_GUARD_REQUIRED' USING ERRCODE='22023';
    END IF;
    proof_revision := CASE WHEN p_policy_guard->>'kind'='preview' THEN actual_revision+1 ELSE actual_revision END;
    IF (proof_row->>'expectedRevision')::bigint IS DISTINCT FROM proof_revision THEN
      RAISE EXCEPTION 'PDL_POLICY_GUARD_REQUIRED' USING ERRCODE='22023';
    END IF;
    IF jsonb_typeof(session_row->'expiresAt') IS DISTINCT FROM 'string'
       OR jsonb_typeof(proof_row->'expiresAt') IS DISTINCT FROM 'number'
       OR COALESCE(proof_row->>'expiresAt','') !~ '^[0-9]{1,16}$'
       OR (proof_row->>'expiresAt')::numeric >= 9007199254740991 THEN
      RAISE EXCEPTION 'PDL_POLICY_AUTHORIZATION_REVOKED' USING ERRCODE='22023';
    END IF;
    BEGIN
      guard_deadline := (p_policy_guard->>'authorizedUntil')::timestamptz;
      session_deadline := (session_row->>'expiresAt')::timestamptz;
      proof_deadline := to_timestamp((proof_row->>'expiresAt')::double precision/1000);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'PDL_POLICY_AUTHORIZATION_REVOKED' USING ERRCODE='22023';
    END;
    IF guard_deadline IS NULL OR session_deadline IS NULL OR proof_deadline IS NULL
       OR NOT isfinite(guard_deadline) OR NOT isfinite(session_deadline) OR NOT isfinite(proof_deadline) THEN
      RAISE EXCEPTION 'PDL_POLICY_AUTHORIZATION_REVOKED' USING ERRCODE='22023';
    END IF;
    deadline := LEAST(guard_deadline,session_deadline,proof_deadline);
    IF clock_timestamp() >= deadline THEN
      RAISE EXCEPTION 'PDL_POLICY_AUTHORIZATION_EXPIRED' USING ERRCODE='22023';
    END IF;
    IF phase=0 THEN
      RETURN QUERY SELECT * FROM public.replace_tenant_records(p_company_id,p_expected_revision,p_scalar_data,p_content_hash,p_records);
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.replace_tenant_policy_records(uuid,bigint,jsonb,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.replace_tenant_policy_records(uuid,bigint,jsonb,text,jsonb,jsonb) TO service_role;
COMMIT;
