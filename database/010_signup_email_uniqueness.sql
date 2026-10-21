BEGIN;

-- Login resolves a company from an email address, so one active normalized
-- email must never identify two tenants. Keep historical conflicts visible to
-- operators while deterministically retaining the same winner used by the
-- pre-migration lookup (most activity, then newest account).
CREATE TABLE IF NOT EXISTS private.tenant_email_conflicts (
  normalized_email text NOT NULL,
  retained_company_id uuid NOT NULL,
  conflicted_company_id uuid NOT NULL,
  authorized_company_id uuid NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution_note text,
  PRIMARY KEY (normalized_email, conflicted_company_id),
  CHECK (retained_company_id <> conflicted_company_id),
  CHECK (char_length(normalized_email) BETWEEN 1 AND 320),
  CHECK (resolved_by IS NULL OR char_length(resolved_by) BETWEEN 1 AND 200),
  CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 1000)
);

-- Make the migration safe to resume on a database where the first revision of
-- this table was already created. The authorized owner is durable policy, not
-- a one-time cleanup result: future tenant saves consult it before rebuilding
-- the login directory.
ALTER TABLE private.tenant_email_conflicts
  ADD COLUMN IF NOT EXISTS authorized_company_id uuid;
ALTER TABLE private.tenant_email_conflicts
  ADD COLUMN IF NOT EXISTS resolved_by text;
ALTER TABLE private.tenant_email_conflicts
  ADD COLUMN IF NOT EXISTS resolution_note text;
UPDATE private.tenant_email_conflicts
SET authorized_company_id = retained_company_id
WHERE authorized_company_id IS NULL;
ALTER TABLE private.tenant_email_conflicts
  ALTER COLUMN authorized_company_id SET NOT NULL;

ALTER TABLE private.tenant_email_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.tenant_email_conflicts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.tenant_email_conflicts FROM PUBLIC, anon, authenticated, service_role;

LOCK TABLE private.tenant_directory, private.tenant_active_user_emails
  IN SHARE ROW EXCLUSIVE MODE;

-- Archived companies retain their records for recovery, but must relinquish
-- login-email ownership so they cannot block a current account or a new
-- signup. Unarchiving rebuilds ownership through replace_tenant_records and
-- therefore fails atomically if another active tenant now owns the address.
DELETE FROM private.tenant_active_user_emails AS email
USING private.tenant_directory AS directory
WHERE directory.company_id = email.company_id
  AND lower(COALESCE(directory.company_data->>'archivedDuplicate', 'false')) = 'true';

WITH ranked AS (
  SELECT
    email.normalized_email,
    email.company_id,
    first_value(email.company_id) OVER (
      PARTITION BY email.normalized_email
      ORDER BY
        (directory.project_count + directory.report_count) DESC,
        directory.created_at_text DESC NULLS LAST,
        email.company_id
    ) AS retained_company_id,
    row_number() OVER (
      PARTITION BY email.normalized_email
      ORDER BY
        (directory.project_count + directory.report_count) DESC,
        directory.created_at_text DESC NULLS LAST,
        email.company_id
    ) AS ownership_rank
  FROM private.tenant_active_user_emails AS email
  JOIN private.tenant_directory AS directory ON directory.company_id = email.company_id
  WHERE lower(COALESCE(directory.company_data->>'archivedDuplicate', 'false')) <> 'true'
)
INSERT INTO private.tenant_email_conflicts(
  normalized_email,
  retained_company_id,
  conflicted_company_id,
  authorized_company_id
)
SELECT normalized_email, retained_company_id, company_id, retained_company_id
FROM ranked
WHERE ownership_rank > 1
ON CONFLICT(normalized_email, conflicted_company_id) DO UPDATE SET
  retained_company_id = EXCLUDED.retained_company_id,
  authorized_company_id = COALESCE(
    private.tenant_email_conflicts.authorized_company_id,
    EXCLUDED.authorized_company_id
  );

WITH ranked AS (
  SELECT
    email.normalized_email,
    email.company_id,
    row_number() OVER (
      PARTITION BY email.normalized_email
      ORDER BY
        (directory.project_count + directory.report_count) DESC,
        directory.created_at_text DESC NULLS LAST,
        email.company_id
    ) AS ownership_rank
  FROM private.tenant_active_user_emails AS email
  JOIN private.tenant_directory AS directory ON directory.company_id = email.company_id
  WHERE lower(COALESCE(directory.company_data->>'archivedDuplicate', 'false')) <> 'true'
)
DELETE FROM private.tenant_active_user_emails AS email
USING ranked
WHERE ranked.ownership_rank > 1
  AND email.normalized_email = ranked.normalized_email
  AND email.company_id = ranked.company_id;

-- PostgreSQL enforces this index during replace_tenant_records. Two app
-- instances may both pass an advisory pre-check, but only one transaction can
-- commit the normalized owner email. The constraint name is intentionally
-- stable so the API can map the race to account_exists without exposing SQL.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_active_user_email_owner_unique
  ON private.tenant_active_user_emails(normalized_email);

COMMENT ON INDEX private.tenant_active_user_email_owner_unique IS
  'Global active-login ownership; unique violations map to PDL account_exists.';

-- A losing tenant must remain writable while its login identity is under
-- operator review. Without this durable quarantine, its next unrelated save
-- would try to recreate the losing directory row and the global unique index
-- would reject the whole tenant transaction. The source snapshot is retained
-- for recovery, but the disputed identity cannot authenticate.
CREATE OR REPLACE FUNCTION private.keep_conflicted_tenant_email_quarantined()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM private.tenant_email_conflicts AS conflict
    WHERE conflict.normalized_email = NEW.normalized_email
      AND conflict.authorized_company_id <> NEW.company_id
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.keep_conflicted_tenant_email_quarantined()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS keep_conflicted_tenant_email_quarantined
  ON private.tenant_active_user_emails;
CREATE TRIGGER keep_conflicted_tenant_email_quarantined
BEFORE INSERT OR UPDATE ON private.tenant_active_user_emails
FOR EACH ROW EXECUTE FUNCTION private.keep_conflicted_tenant_email_quarantined();

-- The back office needs a bounded, explicit queue rather than direct access to
-- the private evidence table. This function intentionally returns the email to
-- the authenticated platform server because an operator must contact/identify
-- the affected account; no browser or tenant role can execute it directly.
CREATE OR REPLACE FUNCTION public.list_tenant_email_conflicts(
  p_limit integer DEFAULT 100
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'rows', COALESCE(jsonb_agg(jsonb_build_object(
      'normalizedEmail', queue.normalized_email,
      'retainedCompanyId', queue.retained_company_id,
      'conflictedCompanyId', queue.conflicted_company_id,
      'authorizedCompanyId', queue.authorized_company_id,
      'detectedAt', queue.detected_at,
      'resolvedAt', queue.resolved_at,
      'resolvedBy', queue.resolved_by,
      'resolutionNote', queue.resolution_note
    ) ORDER BY queue.detected_at DESC, queue.normalized_email, queue.conflicted_company_id), '[]'::jsonb)
  )
  FROM (
    SELECT conflict.*
    FROM private.tenant_email_conflicts AS conflict
    ORDER BY conflict.detected_at DESC, conflict.normalized_email, conflict.conflicted_company_id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  ) AS queue;
$$;

-- Resolve all rows for one duplicated identity in a single transaction. The
-- selected owner must still contain that active email in its authoritative
-- tenant records and must not be archived. Rows remain as enforcement/audit
-- evidence so a later save by a non-owner cannot resurrect the ambiguity.
CREATE OR REPLACE FUNCTION public.resolve_tenant_email_conflict(
  p_email text,
  p_authorized_company_id uuid,
  p_resolved_by text,
  p_resolution_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized text := lower(btrim(COALESCE(p_email, '')));
  involved_company_ids uuid[];
  resolution_time timestamptz := now();
  affected integer;
BEGIN
  IF normalized = '' OR char_length(normalized) > 320 OR position('@' IN normalized) < 2 THEN
    RAISE EXCEPTION 'A valid conflict email is required' USING ERRCODE = '22023';
  END IF;
  IF p_authorized_company_id IS NULL THEN
    RAISE EXCEPTION 'An authorized company is required' USING ERRCODE = '22023';
  END IF;
  IF NULLIF(btrim(COALESCE(p_resolved_by, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A resolving operator is required' USING ERRCODE = '22023';
  END IF;

  -- Lock the complete identity conflict set before validating or changing the
  -- owner, so two operators cannot resolve the same address differently.
  PERFORM 1
  FROM private.tenant_email_conflicts AS conflict
  WHERE conflict.normalized_email = normalized
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Email conflict was not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT array_agg(DISTINCT company_id)
  INTO involved_company_ids
  FROM (
    SELECT conflict.retained_company_id AS company_id
    FROM private.tenant_email_conflicts AS conflict
    WHERE conflict.normalized_email = normalized
    UNION
    SELECT conflict.conflicted_company_id
    FROM private.tenant_email_conflicts AS conflict
    WHERE conflict.normalized_email = normalized
  ) AS involved;

  IF NOT (p_authorized_company_id = ANY(involved_company_ids)) THEN
    RAISE EXCEPTION 'Authorized company is not part of this conflict' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM private.tenant_directory AS directory
    WHERE directory.company_id = p_authorized_company_id
      AND lower(COALESCE(directory.company_data->>'archivedDuplicate', 'false')) <> 'true'
  ) THEN
    RAISE EXCEPTION 'Authorized company is not active' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.tenant_records AS record
    WHERE record.company_id = p_authorized_company_id
      AND record.collection = 'users'
      AND lower(COALESCE(record.data->>'status', '')) = 'active'
      AND lower(btrim(COALESCE(record.data->>'email', ''))) = normalized
  ) THEN
    RAISE EXCEPTION 'Authorized company no longer contains this active login' USING ERRCODE = '55000';
  END IF;

  UPDATE private.tenant_email_conflicts
  SET authorized_company_id = p_authorized_company_id,
      resolved_at = resolution_time,
      resolved_by = left(btrim(p_resolved_by), 200),
      resolution_note = NULLIF(left(btrim(COALESCE(p_resolution_note, '')), 1000), '')
  WHERE normalized_email = normalized;
  GET DIAGNOSTICS affected = ROW_COUNT;

  DELETE FROM private.tenant_active_user_emails
  WHERE normalized_email = normalized;
  INSERT INTO private.tenant_active_user_emails(normalized_email, company_id)
  VALUES(normalized, p_authorized_company_id);

  RETURN jsonb_build_object(
    'resolved', true,
    'normalizedEmail', normalized,
    'authorizedCompanyId', p_authorized_company_id,
    'affectedConflicts', affected,
    'resolvedAt', resolution_time
  );
END;
$$;

REVOKE ALL ON FUNCTION public.list_tenant_email_conflicts(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_tenant_email_conflict(text,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_tenant_email_conflicts(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_tenant_email_conflict(text,uuid,text,text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Deployment evidence: duplicate ownership must be zero. Historical rows in
-- tenant_email_conflicts identify accounts that require an operator decision;
-- tenant source snapshots are intentionally never deleted by this migration.
SELECT normalized_email, count(*) AS active_owners
FROM private.tenant_active_user_emails
GROUP BY normalized_email
HAVING count(*) > 1;

SELECT md5(normalized_email) AS email_evidence_hash,
       retained_company_id,
       conflicted_company_id,
       authorized_company_id,
       detected_at,
       resolved_at
FROM private.tenant_email_conflicts
WHERE resolved_at IS NULL
ORDER BY detected_at DESC, email_evidence_hash;

-- No browser or service-role direct table access is allowed.
SELECT table_schema, table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE (table_schema, table_name) IN (
    ('private', 'tenant_active_user_emails'),
    ('private', 'tenant_email_conflicts')
  )
  AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
ORDER BY table_schema, table_name, grantee, privilege_type;
