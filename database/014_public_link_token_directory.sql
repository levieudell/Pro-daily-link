BEGIN;

-- Public guest and change-order credentials must resolve one tenant without
-- downloading every tenant snapshot. The raw credential is never stored;
-- this backend-only directory contains only its SHA-256 verifier.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS private.tenant_public_link_tokens (
  kind text NOT NULL CHECK (kind IN ('guest', 'change_order')),
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  company_id uuid NOT NULL REFERENCES public.tenant_revisions(company_id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, token_hash)
);

CREATE INDEX IF NOT EXISTS tenant_public_link_tokens_company_idx
  ON private.tenant_public_link_tokens(company_id, kind);

ALTER TABLE private.tenant_public_link_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.tenant_public_link_tokens FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.tenant_public_link_tokens
  FROM PUBLIC, anon, authenticated, service_role;

-- Hold snapshot writers until the old records are indexed and the trigger is
-- installed. This removes the cutover window where a credential could exist
-- in the repository but not in the exact-lookup directory.
LOCK TABLE public.tenant_revisions, public.tenant_records IN SHARE ROW EXCLUSIVE MODE;

DELETE FROM private.tenant_public_link_tokens;

INSERT INTO private.tenant_public_link_tokens(kind, token_hash, company_id, revision, updated_at)
SELECT
  CASE record.collection WHEN 'subcontractorLinks' THEN 'guest' ELSE 'change_order' END,
  CASE record.collection
    WHEN 'subcontractorLinks' THEN lower(record.data->>'tokenHash')
    ELSE lower(record.data->>'customerTokenHash')
  END,
  record.company_id,
  state.revision,
  now()
FROM public.tenant_records AS record
JOIN public.tenant_revisions AS state ON state.company_id = record.company_id
WHERE (
    record.collection = 'subcontractorLinks'
    AND record.data->>'tokenHash' ~ '^[a-fA-F0-9]{64}$'
  ) OR (
    record.collection = 'changes'
    AND record.data->>'customerTokenHash' ~ '^[a-fA-F0-9]{64}$'
  );

CREATE OR REPLACE FUNCTION private.sync_tenant_public_link_token()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  link_kind text;
  link_hash text;
  tenant_revision bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.collection = 'subcontractorLinks' THEN
      DELETE FROM private.tenant_public_link_tokens
      WHERE kind = 'guest'
        AND token_hash = lower(COALESCE(OLD.data->>'tokenHash', ''))
        AND company_id = OLD.company_id;
    ELSIF OLD.collection = 'changes' THEN
      DELETE FROM private.tenant_public_link_tokens
      WHERE kind = 'change_order'
        AND token_hash = lower(COALESCE(OLD.data->>'customerTokenHash', ''))
        AND company_id = OLD.company_id;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW.collection = 'subcontractorLinks' THEN
    link_kind := 'guest';
    link_hash := lower(COALESCE(NEW.data->>'tokenHash', ''));
  ELSIF NEW.collection = 'changes' THEN
    link_kind := 'change_order';
    link_hash := lower(COALESCE(NEW.data->>'customerTokenHash', ''));
  ELSE
    RETURN NEW;
  END IF;

  IF link_hash = '' THEN
    RETURN NEW;
  END IF;
  IF link_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Public link token verifier must be SHA-256' USING ERRCODE = '22023';
  END IF;

  SELECT state.revision INTO tenant_revision
  FROM public.tenant_revisions AS state
  WHERE state.company_id = NEW.company_id;
  IF tenant_revision IS NULL THEN
    RAISE EXCEPTION 'Public link tenant revision is missing' USING ERRCODE = '23503';
  END IF;

  -- The primary key makes a verifier belong to exactly one tenant and kind.
  -- A collision aborts the surrounding tenant write rather than silently
  -- redirecting an existing public credential.
  INSERT INTO private.tenant_public_link_tokens(kind, token_hash, company_id, revision, updated_at)
  VALUES(link_kind, link_hash, NEW.company_id, tenant_revision, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_tenant_public_link_token ON public.tenant_records;
CREATE TRIGGER sync_tenant_public_link_token
AFTER INSERT OR UPDATE OR DELETE ON public.tenant_records
FOR EACH ROW EXECUTE FUNCTION private.sync_tenant_public_link_token();

-- replace_tenant_records writes the new record set before it advances the
-- repository revision. The record trigger above therefore sees the previous
-- revision while indexing new public-link verifiers. Advance every verifier
-- for the company in the same transaction as the authoritative revision row
-- so directory metadata can never commit one revision behind the repository.
CREATE OR REPLACE FUNCTION private.sync_tenant_public_link_token_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE private.tenant_public_link_tokens
  SET revision = NEW.revision,
      updated_at = now()
  WHERE company_id = NEW.company_id
    AND revision IS DISTINCT FROM NEW.revision;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_tenant_public_link_token_revision ON public.tenant_revisions;
CREATE TRIGGER sync_tenant_public_link_token_revision
AFTER UPDATE OF revision ON public.tenant_revisions
FOR EACH ROW
WHEN (OLD.revision IS DISTINCT FROM NEW.revision)
EXECUTE FUNCTION private.sync_tenant_public_link_token_revision();

CREATE OR REPLACE FUNCTION public.find_tenant_company_by_public_token(
  p_kind text,
  p_token_hash text
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'companyId', COALESCE(NULLIF(directory.company_data->>'id', ''), link.company_id::text),
    'databaseCompanyId', link.company_id,
    'revision', directory.revision
  )
  FROM private.tenant_public_link_tokens AS link
  JOIN private.tenant_directory AS directory ON directory.company_id = link.company_id
  WHERE link.kind = p_kind
    AND link.token_hash = lower(p_token_hash)
    AND p_kind IN ('guest', 'change_order')
    AND p_token_hash ~ '^[a-f0-9]{64}$'
    AND lower(COALESCE(directory.company_data->>'archivedDuplicate', 'false')) <> 'true';
$$;

REVOKE ALL ON FUNCTION private.sync_tenant_public_link_token()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.sync_tenant_public_link_token_revision()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.find_tenant_company_by_public_token(text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_tenant_company_by_public_token(text,text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Deployment verification: only service_role may execute the public lookup,
-- no browser/database role may read the verifier directory directly, and both
-- record synchronization and authoritative revision synchronization are on.
SELECT routine_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND routine_name = 'find_tenant_company_by_public_token'
ORDER BY grantee;

SELECT table_schema, table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'private'
  AND table_name = 'tenant_public_link_tokens'
  AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role');

SELECT event_object_table, trigger_name, event_manipulation, action_timing
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND (
    (event_object_table = 'tenant_records'
      AND trigger_name = 'sync_tenant_public_link_token')
    OR
    (event_object_table = 'tenant_revisions'
      AND trigger_name = 'sync_tenant_public_link_token_revision')
  )
ORDER BY event_object_table, event_manipulation;
