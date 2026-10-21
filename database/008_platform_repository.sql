BEGIN;

-- Platform operations data is not customer tenant data. Keep it in a private
-- schema and expose only two tightly scoped, server-only RPCs. The browser
-- never receives a Supabase secret/service-role credential.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS private.platform_state (
  namespace_id uuid PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  scalar_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scalar_data) = 'object'),
  content_hash text NOT NULL DEFAULT '' CHECK (content_hash = '' OR content_hash ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT 'platform-server' CHECK (char_length(updated_by) BETWEEN 1 AND 200)
);

CREATE TABLE IF NOT EXISTS private.platform_records (
  namespace_id uuid NOT NULL REFERENCES private.platform_state(namespace_id) ON DELETE CASCADE,
  collection text NOT NULL CHECK (collection ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  record_key text NOT NULL CHECK (char_length(record_key) BETWEEN 1 AND 200),
  position integer NOT NULL CHECK (position >= 0),
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace_id, collection, record_key),
  UNIQUE (namespace_id, collection, position)
);

CREATE INDEX IF NOT EXISTS platform_records_namespace_collection_idx
  ON private.platform_records(namespace_id, collection, position);

CREATE TABLE IF NOT EXISTS private.platform_revision_log (
  namespace_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  record_count integer NOT NULL CHECK (record_count >= 0),
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text NOT NULL CHECK (char_length(changed_by) BETWEEN 1 AND 200),
  PRIMARY KEY (namespace_id, revision)
);

-- Defense in depth: the private schema is not exposed through the Data API,
-- and these tables also have forced RLS with no browser policies.
ALTER TABLE private.platform_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.platform_state FORCE ROW LEVEL SECURITY;
ALTER TABLE private.platform_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.platform_records FORCE ROW LEVEL SECURITY;
ALTER TABLE private.platform_revision_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.platform_revision_log FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE private.platform_state FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.platform_records FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.platform_revision_log FROM PUBLIC, anon, authenticated, service_role;

-- A single read gives the server one self-consistent committed revision.
CREATE OR REPLACE FUNCTION public.load_platform_repository(p_namespace_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'namespaceId', state.namespace_id,
    'revision', state.revision,
    'scalarData', state.scalar_data,
    'contentHash', state.content_hash,
    'updatedAt', state.updated_at,
    'updatedBy', state.updated_by,
    'records', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'collection', record.collection,
          'recordKey', record.record_key,
          'position', record.position,
          'data', record.data
        ) ORDER BY record.collection, record.position
      )
      FROM private.platform_records AS record
      WHERE record.namespace_id = state.namespace_id
    ), '[]'::jsonb)
  )
  FROM private.platform_state AS state
  WHERE state.namespace_id = p_namespace_id;
$$;

-- Compare-and-swap prevents a stale process from silently replacing a newer
-- platform snapshot. The row lock also closes the two-first-writers race.
CREATE OR REPLACE FUNCTION public.replace_platform_repository(
  p_namespace_id uuid,
  p_expected_revision bigint,
  p_scalar_data jsonb,
  p_content_hash text,
  p_records jsonb,
  p_changed_by text DEFAULT 'platform-server'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_revision bigint;
  next_revision bigint;
  supplied_count integer;
  inserted_count integer;
  actor text;
BEGIN
  IF p_namespace_id IS NULL THEN
    RAISE EXCEPTION 'Platform namespace is required' USING ERRCODE = '22023';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'Expected platform revision must be a non-negative integer' USING ERRCODE = '22023';
  END IF;
  IF p_scalar_data IS NULL OR jsonb_typeof(p_scalar_data) <> 'object' THEN
    RAISE EXCEPTION 'Platform scalar data must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF p_records IS NULL OR jsonb_typeof(p_records) <> 'array' THEN
    RAISE EXCEPTION 'Platform records must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF p_content_hash IS NULL OR p_content_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Platform content hash must be SHA-256' USING ERRCODE = '22023';
  END IF;
  actor := left(COALESCE(NULLIF(btrim(p_changed_by), ''), 'platform-server'), 200);

  -- A SELECT FOR UPDATE on a missing row locks nothing. Materialize revision
  -- zero first so concurrent first writes serialize on the same row.
  INSERT INTO private.platform_state(
    namespace_id, revision, scalar_data, content_hash, updated_at, updated_by
  ) VALUES (
    p_namespace_id, 0, '{}'::jsonb, '', now(), actor
  ) ON CONFLICT(namespace_id) DO NOTHING;

  SELECT state.revision
  INTO current_revision
  FROM private.platform_state AS state
  WHERE state.namespace_id = p_namespace_id
  FOR UPDATE;

  IF current_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'PDL_PLATFORM_REVISION_CONFLICT expected=% actual=%',
      p_expected_revision, current_revision
      USING ERRCODE = '40001';
  END IF;

  next_revision := current_revision + 1;
  supplied_count := jsonb_array_length(p_records);

  DELETE FROM private.platform_records
  WHERE namespace_id = p_namespace_id;

  INSERT INTO private.platform_records(
    namespace_id, collection, record_key, position, data, updated_at
  )
  SELECT
    p_namespace_id,
    item.collection,
    item.record_key,
    item.position,
    item.data,
    now()
  FROM jsonb_to_recordset(p_records)
    AS item(collection text, record_key text, position integer, data jsonb);

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> supplied_count THEN
    RAISE EXCEPTION 'Platform record count mismatch expected=% actual=%',
      supplied_count, inserted_count
      USING ERRCODE = '22023';
  END IF;

  UPDATE private.platform_state
  SET revision = next_revision,
      scalar_data = p_scalar_data,
      content_hash = p_content_hash,
      updated_at = now(),
      updated_by = actor
  WHERE namespace_id = p_namespace_id;

  INSERT INTO private.platform_revision_log(
    namespace_id, revision, content_hash, record_count, changed_at, changed_by
  ) VALUES (
    p_namespace_id, next_revision, p_content_hash, inserted_count, now(), actor
  );

  RETURN jsonb_build_object(
    'namespaceId', p_namespace_id,
    'revision', next_revision,
    'recordCount', inserted_count,
    'contentHash', p_content_hash,
    'updatedAt', now()
  );
END;
$$;

-- Public-schema functions receive EXECUTE broadly by default on some Supabase
-- projects. Remove every browser/public path, then add only server authority.
REVOKE ALL ON FUNCTION public.load_platform_repository(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.replace_platform_repository(uuid,bigint,jsonb,text,jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_platform_repository(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.replace_platform_repository(uuid,bigint,jsonb,text,jsonb,text) TO service_role;

COMMIT;

-- Deployment verification: no row below may show anon/authenticated EXECUTE.
SELECT routine_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND routine_name IN ('load_platform_repository', 'replace_platform_repository')
ORDER BY routine_name, grantee;
