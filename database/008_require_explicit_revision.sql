-- Draft source only: never apply to an existing tenant without cutover approval.
BEGIN;
CREATE OR REPLACE FUNCTION public.replace_tenant_records(
  p_company_id uuid,
  p_expected_revision bigint,
  p_scalar_data jsonb,
  p_content_hash text,
  p_records jsonb
) RETURNS TABLE(revision bigint, record_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_revision bigint;
  next_revision bigint;
BEGIN
  IF p_expected_revision IS NULL OR p_expected_revision < 0 OR p_expected_revision >= 9007199254740991 THEN
    RAISE EXCEPTION 'PDL_EXPECTED_REVISION_REQUIRED' USING ERRCODE = '22023';
  END IF;
  -- Materialize revision zero before locking it. A SELECT ... FOR UPDATE on a
  -- missing row locks nothing and would let two first writers both proceed.
  INSERT INTO tenant_revisions(company_id, revision, scalar_data, content_hash, updated_at)
  VALUES(p_company_id, 0, '{}'::jsonb, '', now())
  ON CONFLICT(company_id) DO NOTHING;

  SELECT tr.revision INTO current_revision
  FROM tenant_revisions tr
  WHERE tr.company_id = p_company_id
  FOR UPDATE;

  IF current_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'PDL_REVISION_CONFLICT expected=% actual=%', p_expected_revision, current_revision USING ERRCODE = '40001';
  END IF;
  next_revision := current_revision + 1;

  INSERT INTO tenant_revisions(company_id, revision, scalar_data, content_hash, updated_at)
  VALUES(p_company_id, next_revision, COALESCE(p_scalar_data, '{}'::jsonb), p_content_hash, now())
  ON CONFLICT(company_id) DO UPDATE SET
    revision = EXCLUDED.revision,
    scalar_data = EXCLUDED.scalar_data,
    content_hash = EXCLUDED.content_hash,
    updated_at = now();

  DELETE FROM tenant_records WHERE company_id = p_company_id;
  INSERT INTO tenant_records(company_id, collection, record_key, position, data)
  SELECT p_company_id, item.collection, item.record_key, item.position, item.data
  FROM jsonb_to_recordset(COALESCE(p_records, '[]'::jsonb))
    AS item(collection text, record_key text, position integer, data jsonb);

  RETURN QUERY SELECT next_revision, jsonb_array_length(COALESCE(p_records, '[]'::jsonb))::bigint;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb) TO service_role;

COMMIT;
