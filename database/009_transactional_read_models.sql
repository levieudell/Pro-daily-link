BEGIN;

-- Transactional tenant reads previously fetched tenant_revisions and
-- tenant_records in separate HTTP requests. A writer could commit between
-- those requests, producing a torn snapshot. These server-only RPCs assemble
-- state and records in one PostgreSQL statement/MVCC snapshot.
--
-- The compact directory is updated in the same transaction as each tenant
-- revision. It lets authentication and the platform company list use indexed
-- lookups without downloading every customer's projects, reports and dailies.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

-- The legacy tenant helper reads only a custom setting, so it does not need
-- caller-controlled schema resolution. Pinning the path clears the database
-- advisor warning and prevents a same-named object from changing its meaning.
ALTER FUNCTION public.app_company_id() SET search_path = '';

CREATE TABLE IF NOT EXISTS private.tenant_directory (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision >= 0),
  company_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(company_data) = 'object'),
  user_count integer NOT NULL DEFAULT 0 CHECK (user_count >= 0),
  project_count integer NOT NULL DEFAULT 0 CHECK (project_count >= 0),
  report_count integer NOT NULL DEFAULT 0 CHECK (report_count >= 0),
  last_report_text text,
  created_at_text text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS private.tenant_active_user_emails (
  normalized_email text NOT NULL CHECK (
    normalized_email = lower(btrim(normalized_email))
    AND normalized_email <> ''
    AND char_length(normalized_email) <= 320
  ),
  company_id uuid NOT NULL REFERENCES private.tenant_directory(company_id) ON DELETE CASCADE,
  PRIMARY KEY (normalized_email, company_id)
);

CREATE INDEX IF NOT EXISTS tenant_directory_updated_idx
  ON private.tenant_directory(updated_at DESC, company_id);

CREATE INDEX IF NOT EXISTS tenant_active_user_emails_company_idx
  ON private.tenant_active_user_emails(company_id);

ALTER TABLE private.tenant_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.tenant_directory FORCE ROW LEVEL SECURITY;
ALTER TABLE private.tenant_active_user_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.tenant_active_user_emails FORCE ROW LEVEL SECURITY;

-- No browser or direct service-role table access. The service role receives
-- EXECUTE only on the bounded RPCs below.
REVOKE ALL ON TABLE private.tenant_directory FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.tenant_active_user_emails FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.tenant_revisions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.tenant_records FROM PUBLIC, anon, authenticated, service_role;

-- Backfill the compact projection for revisions that existed before this
-- migration. Block snapshot writers from the start of the backfill through
-- the function replacement/commit. This closes the deployment race where an
-- in-flight old replace_tenant_records function could otherwise commit after
-- the backfill without updating the new directory.
LOCK TABLE public.tenant_revisions, public.tenant_records IN SHARE ROW EXCLUSIVE MODE;

-- All source rows are now read from a stable migration cutover point.
DELETE FROM private.tenant_directory AS directory
WHERE NOT EXISTS (
  SELECT 1
  FROM public.tenant_revisions AS state
  WHERE state.company_id = directory.company_id
);
DELETE FROM private.tenant_active_user_emails;

WITH metrics AS (
  SELECT
    record.company_id,
    count(*) FILTER (WHERE record.collection = 'users')::integer AS user_count,
    count(*) FILTER (WHERE record.collection = 'projects')::integer AS project_count,
    count(*) FILTER (WHERE record.collection = 'reports')::integer AS report_count,
    max(NULLIF(COALESCE(record.data->>'createdAt', record.data->>'dateIso'), ''))
      FILTER (WHERE record.collection = 'reports') AS last_report_text
  FROM public.tenant_records AS record
  GROUP BY record.company_id
)
INSERT INTO private.tenant_directory(
  company_id,
  revision,
  company_data,
  user_count,
  project_count,
  report_count,
  last_report_text,
  created_at_text,
  updated_at
)
SELECT
  state.company_id,
  state.revision,
  CASE
    WHEN jsonb_typeof(state.scalar_data->'company') = 'object' THEN state.scalar_data->'company'
    ELSE '{}'::jsonb
  END,
  COALESCE(metrics.user_count, 0),
  COALESCE(metrics.project_count, 0),
  COALESCE(metrics.report_count, 0),
  metrics.last_report_text,
  NULLIF(state.scalar_data->'company'->>'createdAt', ''),
  state.updated_at
FROM public.tenant_revisions AS state
LEFT JOIN metrics ON metrics.company_id = state.company_id
ON CONFLICT(company_id) DO UPDATE SET
  revision = EXCLUDED.revision,
  company_data = EXCLUDED.company_data,
  user_count = EXCLUDED.user_count,
  project_count = EXCLUDED.project_count,
  report_count = EXCLUDED.report_count,
  last_report_text = EXCLUDED.last_report_text,
  created_at_text = EXCLUDED.created_at_text,
  updated_at = EXCLUDED.updated_at;

INSERT INTO private.tenant_active_user_emails(normalized_email, company_id)
SELECT DISTINCT
  lower(btrim(record.data->>'email')),
  record.company_id
FROM public.tenant_records AS record
JOIN private.tenant_directory AS directory
  ON directory.company_id = record.company_id
WHERE record.collection = 'users'
  AND lower(COALESCE(directory.company_data->>'archivedDuplicate', 'false')) <> 'true'
  AND lower(COALESCE(record.data->>'status', '')) = 'active'
  AND NULLIF(lower(btrim(record.data->>'email')), '') IS NOT NULL
  AND char_length(lower(btrim(record.data->>'email'))) <= 320
ON CONFLICT(normalized_email, company_id) DO NOTHING;

-- Preserve the existing write contract while updating the compact directory
-- and email index atomically with the authoritative snapshot revision.
CREATE OR REPLACE FUNCTION public.replace_tenant_records(
  p_company_id uuid,
  p_expected_revision bigint,
  p_scalar_data jsonb,
  p_content_hash text,
  p_records jsonb
) RETURNS TABLE(revision bigint, record_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_revision bigint;
  next_revision bigint;
  supplied_count integer;
  inserted_count integer;
  company_data jsonb;
  company_has_name boolean;
  directory_user_count integer;
  directory_project_count integer;
  directory_report_count integer;
  directory_last_report text;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'Tenant company is required' USING ERRCODE = '22023';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'Expected tenant revision must be a non-negative integer' USING ERRCODE = '22023';
  END IF;
  IF p_scalar_data IS NULL OR jsonb_typeof(p_scalar_data) <> 'object' THEN
    RAISE EXCEPTION 'Tenant scalar data must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF p_records IS NULL OR jsonb_typeof(p_records) <> 'array' THEN
    RAISE EXCEPTION 'Tenant records must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF p_content_hash IS NULL OR p_content_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Tenant content hash must be SHA-256' USING ERRCODE = '22023';
  END IF;

  company_data := CASE
    WHEN jsonb_typeof(p_scalar_data->'company') = 'object' THEN p_scalar_data->'company'
    ELSE '{}'::jsonb
  END;
  company_has_name := NULLIF(btrim(company_data->>'name'), '') IS NOT NULL;

  -- The revision and directory tables both reference public.companies. New
  -- signup UUIDs do not have that parent until the first repository commit,
  -- so materialize it here, inside the same atomic RPC, before either child
  -- row is inserted. The deterministic UUID slug cannot collide across
  -- tenants; later legacy-mirror writes may add their compatibility payload.
  INSERT INTO public.companies(id, slug, name)
  VALUES(
    p_company_id,
    'company-' || p_company_id::text,
    left(COALESCE(NULLIF(btrim(company_data->>'name'), ''), 'Company'), 200)
  ) ON CONFLICT(id) DO UPDATE SET
    name = CASE
      WHEN company_has_name THEN EXCLUDED.name
      ELSE public.companies.name
    END;

  INSERT INTO public.tenant_revisions(company_id, revision, scalar_data, content_hash, updated_at)
  VALUES(p_company_id, 0, '{}'::jsonb, '', now())
  ON CONFLICT(company_id) DO NOTHING;

  SELECT state.revision
  INTO current_revision
  FROM public.tenant_revisions AS state
  WHERE state.company_id = p_company_id
  FOR UPDATE;

  IF current_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'PDL_REVISION_CONFLICT expected=% actual=%',
      p_expected_revision, current_revision
      USING ERRCODE = 'PT409';
  END IF;

  next_revision := current_revision + 1;
  supplied_count := jsonb_array_length(p_records);

  DELETE FROM public.tenant_records
  WHERE company_id = p_company_id;

  INSERT INTO public.tenant_records(
    company_id, collection, record_key, position, data, updated_at
  )
  SELECT
    p_company_id,
    item.collection,
    item.record_key,
    item.position,
    item.data,
    now()
  FROM jsonb_to_recordset(p_records)
    AS item(collection text, record_key text, position integer, data jsonb);

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> supplied_count THEN
    RAISE EXCEPTION 'Tenant record count mismatch expected=% actual=%',
      supplied_count, inserted_count
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.tenant_revisions
  SET revision = next_revision,
      scalar_data = p_scalar_data,
      content_hash = p_content_hash,
      updated_at = now()
  WHERE company_id = p_company_id;

  SELECT
    count(*) FILTER (WHERE item.collection = 'users')::integer,
    count(*) FILTER (WHERE item.collection = 'projects')::integer,
    count(*) FILTER (WHERE item.collection = 'reports')::integer,
    max(NULLIF(COALESCE(item.data->>'createdAt', item.data->>'dateIso'), ''))
      FILTER (WHERE item.collection = 'reports')
  INTO
    directory_user_count,
    directory_project_count,
    directory_report_count,
    directory_last_report
  FROM jsonb_to_recordset(p_records)
    AS item(collection text, record_key text, position integer, data jsonb);

  INSERT INTO private.tenant_directory(
    company_id,
    revision,
    company_data,
    user_count,
    project_count,
    report_count,
    last_report_text,
    created_at_text,
    updated_at
  ) VALUES (
    p_company_id,
    next_revision,
    company_data,
    COALESCE(directory_user_count, 0),
    COALESCE(directory_project_count, 0),
    COALESCE(directory_report_count, 0),
    directory_last_report,
    NULLIF(company_data->>'createdAt', ''),
    now()
  ) ON CONFLICT(company_id) DO UPDATE SET
    revision = EXCLUDED.revision,
    company_data = EXCLUDED.company_data,
    user_count = EXCLUDED.user_count,
    project_count = EXCLUDED.project_count,
    report_count = EXCLUDED.report_count,
    last_report_text = EXCLUDED.last_report_text,
    created_at_text = EXCLUDED.created_at_text,
    updated_at = EXCLUDED.updated_at;

  DELETE FROM private.tenant_active_user_emails
  WHERE company_id = p_company_id;

  INSERT INTO private.tenant_active_user_emails(normalized_email, company_id)
  SELECT DISTINCT
    lower(btrim(item.data->>'email')),
    p_company_id
  FROM jsonb_to_recordset(p_records)
    AS item(collection text, record_key text, position integer, data jsonb)
  WHERE lower(COALESCE(company_data->>'archivedDuplicate', 'false')) <> 'true'
    AND item.collection = 'users'
    AND lower(COALESCE(item.data->>'status', '')) = 'active'
    AND NULLIF(lower(btrim(item.data->>'email')), '') IS NOT NULL
    AND char_length(lower(btrim(item.data->>'email'))) <= 320;

  RETURN QUERY SELECT next_revision, inserted_count::bigint;
END;
$$;

-- One company, one statement, one committed MVCC snapshot.
CREATE OR REPLACE FUNCTION public.load_tenant_repository(p_company_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'companyId', state.company_id,
    'revision', state.revision,
    'scalarData', state.scalar_data,
    'contentHash', state.content_hash,
    'records', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'collection', record.collection,
          'recordKey', record.record_key,
          'position', record.position,
          'data', record.data
        ) ORDER BY record.collection, record.position
      )
      FROM public.tenant_records AS record
      WHERE record.company_id = state.company_id
    ), '[]'::jsonb)
  )
  FROM public.tenant_revisions AS state
  WHERE state.company_id = p_company_id;
$$;

-- Bounded keyset pagination for maintenance/recovery paths that genuinely
-- need every full tenant. Each page is internally atomic; ordinary platform
-- listing and login lookup use the compact functions below instead.
CREATE OR REPLACE FUNCTION public.list_tenant_repository_page(
  p_after_company_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH page AS (
    SELECT state.company_id, state.revision, state.scalar_data, state.content_hash
    FROM public.tenant_revisions AS state
    WHERE p_after_company_id IS NULL OR state.company_id > p_after_company_id
    ORDER BY state.company_id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 250)
  ), payload AS (
    SELECT
      state.company_id,
      jsonb_build_object(
        'companyId', state.company_id,
        'revision', state.revision,
        'scalarData', state.scalar_data,
        'contentHash', state.content_hash,
        'records', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'collection', record.collection,
              'recordKey', record.record_key,
              'position', record.position,
              'data', record.data
            ) ORDER BY record.collection, record.position
          )
          FROM public.tenant_records AS record
          WHERE record.company_id = state.company_id
        ), '[]'::jsonb)
      ) AS row_data
    FROM page AS state
  )
  SELECT jsonb_build_object(
    'rows', COALESCE(jsonb_agg(payload.row_data ORDER BY payload.company_id), '[]'::jsonb),
    'nextCompanyId', CASE
      WHEN count(*) = LEAST(GREATEST(COALESCE(p_limit, 100), 1), 250)
      THEN (array_agg(payload.company_id ORDER BY payload.company_id DESC))[1]::text
      ELSE NULL
    END
  )
  FROM payload;
$$;

CREATE OR REPLACE FUNCTION public.list_tenant_directory_page(
  p_after_company_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH page AS (
    SELECT directory.*
    FROM private.tenant_directory AS directory
    WHERE p_after_company_id IS NULL OR directory.company_id > p_after_company_id
    ORDER BY directory.company_id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 1000)
  ), payload AS (
    SELECT
      directory.company_id,
      jsonb_build_object(
        'companyId', COALESCE(NULLIF(directory.company_data->>'id', ''), directory.company_id::text),
        'databaseCompanyId', directory.company_id,
        'revision', directory.revision,
        'company', directory.company_data,
        'users', directory.user_count,
        'projects', directory.project_count,
        'reports', directory.report_count,
        'lastReport', directory.last_report_text,
        'updatedAt', directory.updated_at
      ) AS row_data
    FROM page AS directory
  )
  SELECT jsonb_build_object(
    'rows', COALESCE(jsonb_agg(payload.row_data ORDER BY payload.company_id), '[]'::jsonb),
    'nextCompanyId', CASE
      WHEN count(*) = LEAST(GREATEST(COALESCE(p_limit, 500), 1), 1000)
      THEN (array_agg(payload.company_id ORDER BY payload.company_id DESC))[1]::text
      ELSE NULL
    END
  )
  FROM payload;
$$;

CREATE OR REPLACE FUNCTION public.find_tenant_company_by_email(p_email text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'companyId', COALESCE(NULLIF(directory.company_data->>'id', ''), directory.company_id::text),
    'databaseCompanyId', directory.company_id,
    'revision', directory.revision
  )
  FROM private.tenant_active_user_emails AS email
  JOIN private.tenant_directory AS directory
    ON directory.company_id = email.company_id
  WHERE email.normalized_email = lower(btrim(p_email))
    AND lower(COALESCE(directory.company_data->>'archivedDuplicate', 'false')) <> 'true'
  ORDER BY
    (directory.project_count + directory.report_count) DESC,
    directory.created_at_text DESC NULLS LAST,
    directory.company_id
  LIMIT 1;
$$;

-- Public-schema functions can receive EXECUTE through default privileges.
-- Remove every browser/public route, then grant only the backend service role.
REVOKE ALL ON FUNCTION public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.load_tenant_repository(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_tenant_repository_page(uuid,integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_tenant_directory_page(uuid,integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.find_tenant_company_by_email(text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.load_tenant_repository(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.list_tenant_repository_page(uuid,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.list_tenant_directory_page(uuid,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.find_tenant_company_by_email(text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Deployment verification: no row below may show PUBLIC, anon or
-- authenticated EXECUTE. Direct table grants must also remain empty.
SELECT routine_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND routine_name IN (
    'replace_tenant_records',
    'load_tenant_repository',
    'list_tenant_repository_page',
    'list_tenant_directory_page',
    'find_tenant_company_by_email'
  )
ORDER BY routine_name, grantee;

-- This query must return no rows.
SELECT table_schema, table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE (table_schema, table_name) IN (
    ('public', 'tenant_revisions'),
    ('public', 'tenant_records'),
    ('private', 'tenant_directory'),
    ('private', 'tenant_active_user_emails')
  )
  AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
ORDER BY table_schema, table_name, grantee, privilege_type;
