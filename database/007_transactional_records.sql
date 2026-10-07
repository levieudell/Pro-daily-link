BEGIN;

-- Row-oriented application repository used during the snapshot cutover.
-- One company revision is committed atomically with every changed record set.
CREATE TABLE IF NOT EXISTS public.tenant_revisions (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  scalar_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tenant_records (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  collection text NOT NULL CHECK (collection ~ '^[a-zA-Z][a-zA-Z0-9_]{0,63}$'),
  record_key text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, collection, record_key),
  UNIQUE (company_id, collection, position)
);

CREATE INDEX IF NOT EXISTS tenant_records_company_collection_idx
  ON public.tenant_records(company_id, collection, position);

ALTER TABLE public.tenant_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON public.tenant_revisions;
CREATE POLICY tenant_isolation ON public.tenant_revisions
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

DROP POLICY IF EXISTS tenant_isolation ON public.tenant_records;
CREATE POLICY tenant_isolation ON public.tenant_records
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

REVOKE ALL ON TABLE public.tenant_revisions FROM anon, authenticated;
REVOKE ALL ON TABLE public.tenant_records FROM anon, authenticated;

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
    RAISE EXCEPTION 'PDL_REVISION_CONFLICT expected=% actual=%', p_expected_revision, current_revision USING ERRCODE = 'PT409';
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


