BEGIN;

-- A content-free tombstone is stored outside both legacy and transactional
-- tenant state. It survives deletion of tenant_revisions and blocks every
-- known write path from recreating the same company ID at revision zero.
CREATE TABLE IF NOT EXISTS private.tenant_tombstones (
  company_id uuid PRIMARY KEY,
  tombstone_version bigint NOT NULL DEFAULT 1 CHECK (tombstone_version >= 1),
  terminal_revision bigint NOT NULL CHECK (terminal_revision >= 0),
  deletion_request_id uuid,
  deleted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- This non-PII operation row is the durable boundary between reversible
-- validation and destructive object cleanup.  Once present, every tenant
-- write path is frozen at locked_revision; retries can safely repeat object
-- deletion without racing a newer snapshot or losing the storage manifest.
CREATE TABLE IF NOT EXISTS private.tenant_deletion_operations (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  deletion_request_id uuid NOT NULL,
  locked_revision bigint NOT NULL CHECK (locked_revision >= 0),
  started_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE private.tenant_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.tenant_tombstones FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.tenant_tombstones FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE private.tenant_deletion_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.tenant_deletion_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.tenant_deletion_operations FROM PUBLIC, anon, authenticated, service_role;

-- Resume safely if an earlier revision of migration 012 already replaced a
-- company row but did not yet have the independent guard table.
INSERT INTO private.tenant_tombstones(
  company_id, tombstone_version, terminal_revision, deletion_request_id, deleted_at
)
SELECT company.id, 1, 0, NULL, now()
FROM public.companies AS company
WHERE company.slug = 'deleted-' || company.id::text
ON CONFLICT(company_id) DO NOTHING;

CREATE OR REPLACE FUNCTION private.reject_deleted_tenant_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_company_id uuid;
BEGIN
  target_company_id := CASE
    WHEN TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'companies' THEN NEW.id
    ELSE NEW.company_id
  END;
  IF EXISTS (
    SELECT 1
    FROM private.tenant_tombstones AS tombstone
    WHERE tombstone.company_id = target_company_id
  ) THEN
    RAISE EXCEPTION 'PDL_TENANT_DELETED company=%', target_company_id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.reject_deleted_tenant_write()
  FROM PUBLIC, anon, authenticated, service_role;

-- Cover the legacy full-snapshot upsert and the transactional revision path.
-- The latter also catches old/cached replace_tenant_records implementations.
DROP TRIGGER IF EXISTS reject_deleted_tenant_company_write ON public.companies;
CREATE TRIGGER reject_deleted_tenant_company_write
BEFORE INSERT OR UPDATE ON public.companies
FOR EACH ROW EXECUTE FUNCTION private.reject_deleted_tenant_write();

DROP TRIGGER IF EXISTS reject_deleted_tenant_revision_write ON public.tenant_revisions;
CREATE TRIGGER reject_deleted_tenant_revision_write
BEFORE INSERT OR UPDATE ON public.tenant_revisions
FOR EACH ROW EXECUTE FUNCTION private.reject_deleted_tenant_write();

CREATE OR REPLACE FUNCTION private.reject_finalizing_tenant_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_company_id uuid;
BEGIN
  target_company_id := CASE
    WHEN TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'companies' THEN CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END
    ELSE CASE WHEN TG_OP = 'DELETE' THEN OLD.company_id ELSE NEW.company_id END
  END;
  IF current_setting('pdl.tenant_deletion_finalize', true) = target_company_id::text THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- Serialize the operation-row check with begin/finalize and every direct
  -- normalized write. Without the shared lock, a writer could check before the
  -- operation row becomes visible and commit after the external object sweep.
  PERFORM pg_advisory_xact_lock(hashtextextended(target_company_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM private.tenant_tombstones AS tombstone
    WHERE tombstone.company_id = target_company_id
  ) THEN
    RAISE EXCEPTION 'PDL_TENANT_DELETED company=%', target_company_id
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM private.tenant_deletion_operations AS operation
    WHERE operation.company_id = target_company_id
  ) THEN
    RAISE EXCEPTION 'PDL_TENANT_DELETION_LOCKED company=%', target_company_id
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION private.reject_finalizing_tenant_write()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS reject_finalizing_tenant_company_write ON public.companies;
CREATE TRIGGER reject_finalizing_tenant_company_write
BEFORE INSERT OR UPDATE OR DELETE ON public.companies
FOR EACH ROW EXECUTE FUNCTION private.reject_finalizing_tenant_write();

DROP TRIGGER IF EXISTS reject_finalizing_tenant_revision_write ON public.tenant_revisions;
CREATE TRIGGER reject_finalizing_tenant_revision_write
BEFORE INSERT OR UPDATE OR DELETE ON public.tenant_revisions
FOR EACH ROW EXECUTE FUNCTION private.reject_finalizing_tenant_write();

DROP TRIGGER IF EXISTS reject_finalizing_tenant_record_write ON public.tenant_records;
CREATE TRIGGER reject_finalizing_tenant_record_write
BEFORE INSERT OR UPDATE OR DELETE ON public.tenant_records
FOR EACH ROW EXECUTE FUNCTION private.reject_finalizing_tenant_write();

DO $$
DECLARE
  guarded_table text;
BEGIN
  FOREACH guarded_table IN ARRAY ARRAY[
    'audit_events','guest_links','changes','photos','reports','workdays',
    'assignments','projects','customers','team_members','subcontractors','memberships'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS reject_finalizing_tenant_write ON public.%I', guarded_table);
    EXECUTE format(
      'CREATE TRIGGER reject_finalizing_tenant_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION private.reject_finalizing_tenant_write()',
      guarded_table
    );
  END LOOP;
END;
$$;

-- Acquire the finalizing lock before the application deletes a single object.
-- The row lock and operation insert commit atomically, so a revision conflict
-- can only happen before storage cleanup starts. Repeating the exact request is
-- idempotent and returns the original lock receipt.
CREATE OR REPLACE FUNCTION public.begin_tenant_repository_purge(
  p_company_id uuid,
  p_expected_revision bigint,
  p_deletion_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  state public.tenant_revisions%ROWTYPE;
  operation private.tenant_deletion_operations%ROWTYPE;
  company_data jsonb;
  request_data jsonb;
  request_id uuid;
  hold_ends_at timestamptz;
BEGIN
  IF p_company_id IS NULL OR p_deletion_request_id IS NULL THEN
    RAISE EXCEPTION 'Tenant and deletion request are required' USING ERRCODE = '22023';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'Expected tenant revision must be non-negative' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text, 0));

  SELECT * INTO state
  FROM public.tenant_revisions AS current_state
  WHERE current_state.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant repository does not exist' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO operation
  FROM private.tenant_deletion_operations AS current_operation
  WHERE current_operation.company_id = p_company_id;
  IF FOUND THEN
    IF operation.deletion_request_id <> p_deletion_request_id
       OR operation.locked_revision <> p_expected_revision THEN
      RAISE EXCEPTION 'A different permanent deletion is already finalizing'
        USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object(
      'locked', true,
      'companyId', p_company_id,
      'deletionRequestId', operation.deletion_request_id,
      'lockedRevision', operation.locked_revision,
      'startedAt', operation.started_at,
      'resumed', true
    );
  END IF;

  IF state.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'PDL_REVISION_CONFLICT expected=% actual=%', p_expected_revision, state.revision
      USING ERRCODE = 'PT409';
  END IF;
  company_data := state.scalar_data->'company';
  request_data := company_data->'deletionRequest';
  IF jsonb_typeof(company_data) <> 'object' OR jsonb_typeof(request_data) <> 'object' THEN
    RAISE EXCEPTION 'A durable deletion request is required' USING ERRCODE = '55000';
  END IF;
  IF request_data->>'status' <> 'Recovery hold' THEN
    RAISE EXCEPTION 'Tenant is not in a recovery hold' USING ERRCODE = '55000';
  END IF;
  BEGIN
    request_id := (request_data->>'id')::uuid;
    hold_ends_at := (request_data->>'holdEndsAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Deletion request evidence is invalid' USING ERRCODE = '22023';
  END;
  IF request_id <> p_deletion_request_id THEN
    RAISE EXCEPTION 'Deletion request identity mismatch' USING ERRCODE = '42501';
  END IF;
  IF hold_ends_at IS NULL OR hold_ends_at > now() THEN
    RAISE EXCEPTION 'The recovery hold has not elapsed' USING ERRCODE = '55000';
  END IF;
  IF COALESCE((request_data->>'legalHold')::boolean, false) THEN
    RAISE EXCEPTION 'Tenant is under legal hold' USING ERRCODE = '55000';
  END IF;

  INSERT INTO private.tenant_deletion_operations(
    company_id, deletion_request_id, locked_revision, started_at
  ) VALUES (
    p_company_id, p_deletion_request_id, state.revision, now()
  );

  RETURN jsonb_build_object(
    'locked', true,
    'companyId', p_company_id,
    'deletionRequestId', p_deletion_request_id,
    'lockedRevision', state.revision,
    'startedAt', now(),
    'resumed', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.begin_tenant_repository_purge(uuid,bigint,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_tenant_repository_purge(uuid,bigint,uuid)
  TO service_role;

-- A content-free receipt lets the application resolve a lost HTTP response:
-- "locked" means retry, while "deleted" proves the irreversible commit won.
CREATE OR REPLACE FUNCTION public.tenant_repository_deletion_status(
  p_company_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  tombstone private.tenant_tombstones%ROWTYPE;
  operation private.tenant_deletion_operations%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text, 0));

  SELECT * INTO tombstone
  FROM private.tenant_tombstones AS receipt
  WHERE receipt.company_id = p_company_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'deleted',
      'companyId', p_company_id,
      'deletionRequestId', tombstone.deletion_request_id,
      'terminalRevision', tombstone.terminal_revision,
      'tombstoneVersion', tombstone.tombstone_version,
      'deletedAt', tombstone.deleted_at
    );
  END IF;

  SELECT * INTO operation
  FROM private.tenant_deletion_operations AS pending
  WHERE pending.company_id = p_company_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'locked',
      'companyId', p_company_id,
      'deletionRequestId', operation.deletion_request_id,
      'lockedRevision', operation.locked_revision,
      'startedAt', operation.started_at
    );
  END IF;

  RETURN jsonb_build_object('status', 'not_started', 'companyId', p_company_id);
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_repository_deletion_status(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_repository_deletion_status(uuid)
  TO service_role;

-- Permanently remove a tenant only after the application has placed it in an
-- operator-reviewed recovery hold and the 30-day hold has elapsed.  The
-- service role cannot bypass the request identity, revision, or hold date.
CREATE OR REPLACE FUNCTION public.purge_tenant_repository(
  p_company_id uuid,
  p_expected_revision bigint,
  p_deletion_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  state public.tenant_revisions%ROWTYPE;
  operation private.tenant_deletion_operations%ROWTYPE;
  tombstone private.tenant_tombstones%ROWTYPE;
  company_data jsonb;
  request_data jsonb;
  request_id uuid;
  hold_ends_at timestamptz;
  deleted_at timestamptz := now();
  tenant_user_ids uuid[];
BEGIN
  IF p_company_id IS NULL OR p_deletion_request_id IS NULL THEN
    RAISE EXCEPTION 'Tenant and deletion request are required' USING ERRCODE = '22023';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'Expected tenant revision must be non-negative' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text, 0));

  SELECT * INTO tombstone
  FROM private.tenant_tombstones AS receipt
  WHERE receipt.company_id = p_company_id;
  IF FOUND THEN
    IF tombstone.deletion_request_id <> p_deletion_request_id
       OR tombstone.terminal_revision <> p_expected_revision THEN
      RAISE EXCEPTION 'Permanent deletion receipt does not match this request'
        USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object(
      'deleted', true,
      'companyId', p_company_id,
      'deletionRequestId', tombstone.deletion_request_id,
      'deletedAt', tombstone.deleted_at,
      'tombstoneVersion', tombstone.tombstone_version,
      'terminalRevision', tombstone.terminal_revision,
      'resumed', true
    );
  END IF;

  SELECT * INTO operation
  FROM private.tenant_deletion_operations AS pending
  WHERE pending.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Permanent deletion must be locked before object cleanup'
      USING ERRCODE = '55000';
  END IF;
  IF operation.deletion_request_id <> p_deletion_request_id
     OR operation.locked_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'Permanent deletion lock does not match this request'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO state
  FROM public.tenant_revisions AS current_state
  WHERE current_state.company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant repository does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF state.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'PDL_REVISION_CONFLICT expected=% actual=%', p_expected_revision, state.revision
      USING ERRCODE = 'PT409';
  END IF;

  company_data := state.scalar_data->'company';
  request_data := company_data->'deletionRequest';
  IF jsonb_typeof(company_data) <> 'object' OR jsonb_typeof(request_data) <> 'object' THEN
    RAISE EXCEPTION 'A durable deletion request is required' USING ERRCODE = '55000';
  END IF;
  IF request_data->>'status' <> 'Recovery hold' THEN
    RAISE EXCEPTION 'Tenant is not in a recovery hold' USING ERRCODE = '55000';
  END IF;
  BEGIN
    request_id := (request_data->>'id')::uuid;
    hold_ends_at := (request_data->>'holdEndsAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Deletion request evidence is invalid' USING ERRCODE = '22023';
  END;
  IF request_id <> p_deletion_request_id THEN
    RAISE EXCEPTION 'Deletion request identity mismatch' USING ERRCODE = '42501';
  END IF;
  IF hold_ends_at IS NULL OR hold_ends_at > deleted_at THEN
    RAISE EXCEPTION 'The recovery hold has not elapsed' USING ERRCODE = '55000';
  END IF;
  IF COALESCE((request_data->>'legalHold')::boolean, false) THEN
    RAISE EXCEPTION 'Tenant is under legal hold' USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('pdl.tenant_deletion_finalize', p_company_id::text, true);

  DELETE FROM private.tenant_active_user_emails WHERE company_id = p_company_id;
  -- Conflict evidence contains a normalized email address. Permanent deletion
  -- must remove every row tied to the erased tenant rather than retaining PII
  -- in an operator queue indefinitely.
  DELETE FROM private.tenant_email_conflicts
  WHERE retained_company_id = p_company_id
     OR conflicted_company_id = p_company_id
     OR authorized_company_id = p_company_id;
  DELETE FROM private.tenant_directory WHERE company_id = p_company_id;
  DELETE FROM public.tenant_records WHERE company_id = p_company_id;
  DELETE FROM public.tenant_revisions WHERE company_id = p_company_id;

  -- Remove any records written through the normalized foundation as well as
  -- the transactional repository. The current application uses the latter,
  -- but deletion must remain complete through the schema cutover.
  SELECT array_agg(membership.user_id) INTO tenant_user_ids
  FROM public.memberships AS membership WHERE membership.company_id = p_company_id;
  DELETE FROM public.audit_events WHERE company_id = p_company_id;
  DELETE FROM public.guest_links WHERE company_id = p_company_id;
  DELETE FROM public.changes WHERE company_id = p_company_id;
  DELETE FROM public.photos WHERE company_id = p_company_id;
  DELETE FROM public.reports WHERE company_id = p_company_id;
  DELETE FROM public.workdays WHERE company_id = p_company_id;
  DELETE FROM public.assignments WHERE company_id = p_company_id;
  DELETE FROM public.projects WHERE company_id = p_company_id;
  DELETE FROM public.customers WHERE company_id = p_company_id;
  DELETE FROM public.team_members WHERE company_id = p_company_id;
  DELETE FROM public.subcontractors WHERE company_id = p_company_id;
  DELETE FROM public.memberships WHERE company_id = p_company_id;
  DELETE FROM public.users AS app_user
  WHERE app_user.id = ANY(COALESCE(tenant_user_ids, ARRAY[]::uuid[]))
    AND NOT EXISTS (SELECT 1 FROM public.memberships AS remaining WHERE remaining.user_id = app_user.id);

  -- Remove the write lock inside this same transaction immediately before the
  -- guarded company update. Other transactions continue to see the lock until
  -- commit, while rollback restores it automatically.
  DELETE FROM private.tenant_deletion_operations WHERE company_id = p_company_id;

  -- Retain only a content-free tombstone so a deleted tenant ID cannot be
  -- silently reused and so cascade-dependent schema rows remain valid.
  UPDATE public.companies
  SET slug = 'deleted-' || p_company_id::text,
      name = 'Deleted tenant',
      data = jsonb_build_object(
        'company', jsonb_build_object(
          'id', p_company_id::text,
          'deletedAt', deleted_at,
          'deletionRequestId', p_deletion_request_id
        )
      )
  WHERE id = p_company_id;

  INSERT INTO private.tenant_tombstones(
    company_id,
    tombstone_version,
    terminal_revision,
    deletion_request_id,
    deleted_at
  ) VALUES (
    p_company_id,
    1,
    state.revision,
    p_deletion_request_id,
    deleted_at
  );

  RETURN jsonb_build_object(
    'deleted', true,
    'companyId', p_company_id,
    'deletionRequestId', p_deletion_request_id,
    'deletedAt', deleted_at,
    'tombstoneVersion', 1,
    'terminalRevision', state.revision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_tenant_repository(uuid,bigint,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_tenant_repository(uuid,bigint,uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
