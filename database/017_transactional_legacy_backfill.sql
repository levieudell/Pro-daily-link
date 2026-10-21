BEGIN;

-- One-time, fail-closed bridge from the legacy companies.data snapshot into
-- the normalized tenant repository. The application backfill command calls
-- this function only while the verified maintenance fence is active.
--
-- This function deliberately does not update public.companies. It locks and
-- compares the legacy JSON source inside the same transaction as the insert,
-- so an operator can never initialize from a stale preview. Existing tenant
-- revisions are immutable to this function: an exact row is reported as a
-- no-op and every other existing row is rejected as drift.
CREATE OR REPLACE FUNCTION public.initialize_tenant_repository_from_legacy(
  p_company_id uuid,
  p_source_snapshot jsonb,
  p_scalar_data jsonb,
  p_content_hash text,
  p_records jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $$
DECLARE
  source_snapshot jsonb;
  existing_state public.tenant_revisions%ROWTYPE;
  supplied_count integer;
  inserted_count integer;
  existing_records jsonb;
  supplied_records jsonb;
  reconstructed_snapshot jsonb;
  v_company_data jsonb;
  v_directory_user_count integer;
  v_directory_project_count integer;
  v_directory_report_count integer;
  v_directory_last_report text;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'PDL_BACKFILL_COMPANY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_source_snapshot IS NULL OR jsonb_typeof(p_source_snapshot) <> 'object' OR
     p_scalar_data IS NULL OR jsonb_typeof(p_scalar_data) <> 'object' OR
     p_records IS NULL OR jsonb_typeof(p_records) <> 'array' OR
     p_content_hash IS NULL OR p_content_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'PDL_BACKFILL_PAYLOAD_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Serialize against migration 015's tenant lifecycle guard and every other
  -- backfill attempt for this company. The row lock also serializes against a
  -- legacy snapshot update that does not yet use the advisory lock.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text, 0));
  SELECT company.data
  INTO source_snapshot
  FROM public.companies AS company
  WHERE company.id = p_company_id
  FOR UPDATE;

  IF NOT FOUND OR source_snapshot IS NULL OR jsonb_typeof(source_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'PDL_BACKFILL_LEGACY_SOURCE_MISSING' USING ERRCODE = '55000';
  END IF;
  IF source_snapshot IS DISTINCT FROM p_source_snapshot THEN
    RAISE EXCEPTION 'PDL_BACKFILL_LEGACY_SOURCE_CHANGED' USING ERRCODE = '40001';
  END IF;
  IF jsonb_typeof(source_snapshot->'company') <> 'object' OR
     NULLIF(btrim(source_snapshot->'company'->>'id'), '') IS NULL OR
     source_snapshot->'company'->'archivedDuplicate' = 'true'::jsonb OR
     source_snapshot->'company'->'mcpConnector' = 'true'::jsonb OR
     NULLIF(btrim(source_snapshot->'company'->>'deletedAt'), '') IS NOT NULL OR
     (source_snapshot ? 'mcpOauth' AND
       COALESCE(source_snapshot->'mcpOauth', 'null'::jsonb) NOT IN
         ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)) THEN
    RAISE EXCEPTION 'PDL_BACKFILL_LEGACY_SOURCE_INELIGIBLE' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM private.tenant_tombstones WHERE company_id = p_company_id) OR
     EXISTS (SELECT 1 FROM private.tenant_deletion_operations WHERE company_id = p_company_id) THEN
    RAISE EXCEPTION 'PDL_BACKFILL_TENANT_DELETION_LOCKED' USING ERRCODE = '55000';
  END IF;

  supplied_count := jsonb_array_length(p_records);
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'collection', item.collection,
      'record_key', item.record_key,
      'position', item.position,
      'data', item.data
    ) ORDER BY item.collection, item.position, item.record_key
  ), '[]'::jsonb)
  INTO supplied_records
  FROM jsonb_to_recordset(p_records)
    AS item(collection text, record_key text, position integer, data jsonb);

  IF jsonb_array_length(supplied_records) <> supplied_count OR EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_records)
      AS item(collection text, record_key text, position integer, data jsonb)
    WHERE item.collection IS NULL OR item.collection !~ '^[a-zA-Z][a-zA-Z0-9_]{0,63}$'
      OR item.record_key IS NULL OR item.position IS NULL OR item.position < 0 OR item.data IS NULL
  ) THEN
    RAISE EXCEPTION 'PDL_BACKFILL_PAYLOAD_INVALID' USING ERRCODE = '22023';
  END IF;

  WITH collections AS (
    SELECT item.collection, jsonb_agg(item.data ORDER BY item.position) AS rows
    FROM jsonb_to_recordset(p_records)
      AS item(collection text, record_key text, position integer, data jsonb)
    GROUP BY item.collection
  )
  SELECT p_scalar_data || COALESCE(jsonb_object_agg(collection, rows), '{}'::jsonb)
  INTO reconstructed_snapshot
  FROM collections;
  IF reconstructed_snapshot IS DISTINCT FROM source_snapshot THEN
    RAISE EXCEPTION 'PDL_BACKFILL_PAYLOAD_SOURCE_MISMATCH' USING ERRCODE = '22023';
  END IF;

  v_company_data := p_scalar_data->'company';
  SELECT
    count(*) FILTER (WHERE item.collection = 'users')::integer,
    count(*) FILTER (WHERE item.collection = 'projects')::integer,
    count(*) FILTER (WHERE item.collection = 'reports')::integer,
    max(NULLIF(COALESCE(item.data->>'createdAt', item.data->>'dateIso'), ''))
      FILTER (WHERE item.collection = 'reports')
  INTO v_directory_user_count, v_directory_project_count,
       v_directory_report_count, v_directory_last_report
  FROM jsonb_to_recordset(p_records)
    AS item(collection text, record_key text, position integer, data jsonb);

  SELECT state.* INTO existing_state
  FROM public.tenant_revisions AS state
  WHERE state.company_id = p_company_id
  FOR UPDATE;

  IF FOUND THEN
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'collection', record.collection,
        'record_key', record.record_key,
        'position', record.position,
        'data', record.data
      ) ORDER BY record.collection, record.position, record.record_key
    ), '[]'::jsonb)
    INTO existing_records
    FROM public.tenant_records AS record
    WHERE record.company_id = p_company_id;

    IF existing_state.content_hash = p_content_hash AND
       existing_state.scalar_data = p_scalar_data AND
       existing_records = supplied_records AND
       EXISTS (
         SELECT 1 FROM private.tenant_directory AS directory
         WHERE directory.company_id = p_company_id
           AND directory.revision = existing_state.revision
           AND directory.company_data = v_company_data
           AND directory.user_count = COALESCE(v_directory_user_count, 0)
           AND directory.project_count = COALESCE(v_directory_project_count, 0)
           AND directory.report_count = COALESCE(v_directory_report_count, 0)
           AND directory.last_report_text IS NOT DISTINCT FROM v_directory_last_report
           AND directory.created_at_text IS NOT DISTINCT FROM NULLIF(v_company_data->>'createdAt', '')
       ) AND NOT EXISTS (
         SELECT lower(btrim(item.data->>'email')) AS normalized_email
         FROM jsonb_to_recordset(p_records)
           AS item(collection text, record_key text, position integer, data jsonb)
         WHERE item.collection = 'users'
           AND lower(COALESCE(item.data->>'status', '')) = 'active'
           AND NULLIF(lower(btrim(item.data->>'email')), '') IS NOT NULL
           AND char_length(lower(btrim(item.data->>'email'))) <= 320
         EXCEPT
         SELECT email.normalized_email
         FROM private.tenant_active_user_emails AS email
         WHERE email.company_id = p_company_id
       ) AND NOT EXISTS (
         SELECT email.normalized_email
         FROM private.tenant_active_user_emails AS email
         WHERE email.company_id = p_company_id
         EXCEPT
         SELECT lower(btrim(item.data->>'email')) AS normalized_email
         FROM jsonb_to_recordset(p_records)
           AS item(collection text, record_key text, position integer, data jsonb)
         WHERE item.collection = 'users'
           AND lower(COALESCE(item.data->>'status', '')) = 'active'
           AND NULLIF(lower(btrim(item.data->>'email')), '') IS NOT NULL
           AND char_length(lower(btrim(item.data->>'email'))) <= 320
       ) THEN
      RETURN jsonb_build_object(
        'status', 'exact',
        'companyId', p_company_id,
        'revision', existing_state.revision,
        'recordCount', supplied_count,
        'contentHash', p_content_hash
      );
    END IF;
    RAISE EXCEPTION 'PDL_BACKFILL_TRANSACTIONAL_DRIFT' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.tenant_revisions(
    company_id, revision, scalar_data, content_hash, updated_at
  ) VALUES (
    p_company_id, 0, p_scalar_data, p_content_hash, now()
  );

  INSERT INTO public.tenant_records(
    company_id, collection, record_key, position, data, updated_at
  )
  SELECT p_company_id, item.collection, item.record_key, item.position, item.data, now()
  FROM jsonb_to_recordset(p_records)
    AS item(collection text, record_key text, position integer, data jsonb);
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> supplied_count THEN
    RAISE EXCEPTION 'PDL_BACKFILL_RECORD_COUNT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  INSERT INTO private.tenant_directory(
    company_id, revision, company_data, user_count, project_count,
    report_count, last_report_text, created_at_text, updated_at
  ) VALUES (
    p_company_id, 0, v_company_data,
    COALESCE(v_directory_user_count, 0),
    COALESCE(v_directory_project_count, 0),
    COALESCE(v_directory_report_count, 0),
    v_directory_last_report,
    NULLIF(v_company_data->>'createdAt', ''),
    now()
  );

  INSERT INTO private.tenant_active_user_emails(normalized_email, company_id)
  SELECT DISTINCT lower(btrim(item.data->>'email')), p_company_id
  FROM jsonb_to_recordset(p_records)
    AS item(collection text, record_key text, position integer, data jsonb)
  WHERE item.collection = 'users'
    AND lower(COALESCE(item.data->>'status', '')) = 'active'
    AND NULLIF(lower(btrim(item.data->>'email')), '') IS NOT NULL
    AND char_length(lower(btrim(item.data->>'email'))) <= 320;

  RETURN jsonb_build_object(
    'status', 'initialized',
    'companyId', p_company_id,
    'revision', 0,
    'recordCount', supplied_count,
    'contentHash', p_content_hash
  );
END;
$$;

REVOKE ALL ON FUNCTION public.initialize_tenant_repository_from_legacy(uuid,jsonb,jsonb,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.initialize_tenant_repository_from_legacy(uuid,jsonb,jsonb,text,jsonb)
  TO service_role;

-- Deployment evidence: this must report only service_role=true. PUBLIC is an
-- ACL pseudo-role, not a pg_roles row, so inspect its aclitem explicitly.
WITH target_function AS (
  SELECT procedure.oid, procedure.proacl, procedure.proowner
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'public'
    AND procedure.proname = 'initialize_tenant_repository_from_legacy'
    AND pg_catalog.pg_get_function_identity_arguments(procedure.oid) = 'p_company_id uuid, p_source_snapshot jsonb, p_scalar_data jsonb, p_content_hash text, p_records jsonb'
)
SELECT role_name,
       CASE
         WHEN role_name = 'PUBLIC' THEN EXISTS (
           SELECT 1
           FROM target_function
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(target_function.proacl, pg_catalog.acldefault('f', target_function.proowner))
           ) AS acl
           WHERE acl.grantee = 0
             AND acl.privilege_type = 'EXECUTE'
         )
         ELSE COALESCE((
           SELECT pg_catalog.has_function_privilege(role.oid, target_function.oid, 'EXECUTE')
           FROM pg_catalog.pg_roles AS role
           CROSS JOIN target_function
           WHERE role.rolname = role_name
         ), false)
       END AS can_execute
FROM (VALUES ('PUBLIC'::text), ('anon'), ('authenticated'), ('service_role')) AS roles(role_name)
ORDER BY role_name;

COMMIT;
