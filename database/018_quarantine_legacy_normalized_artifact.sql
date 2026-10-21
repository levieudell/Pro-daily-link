BEGIN;

-- This migration creates a deliberately one-purpose recovery control for the
-- orphaned normalized import discovered before transactional cutover.  The
-- UUIDs are constants by design: this function cannot be reused to archive a
-- customer.  It never deletes data and the only mutable column it can touch is
-- public.companies.data on the exact artifact row, while that value is still
-- the empty JSON object produced by migration 004.

CREATE OR REPLACE FUNCTION private.pdl_legacy_normalized_artifact_state(
  p_archived_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET statement_timeout = '30s'
AS $$
DECLARE
  target_id constant uuid := '86479331-4c63-5cc3-8633-a8d7fd5751b3';
  survivor_id constant uuid := 'd3abe4a7-d659-5d07-bc8d-55625616d375';
  target_company public.companies%ROWTYPE;
  survivor_company public.companies%ROWTYPE;
  preserved_document jsonb;
  preserved_sha text;
  preimage_sha text;
  survivor_sha text;
  archive_data jsonb;
  archive_sha text;
  classification text;
  target_ref text;
  survivor_ref text;
  membership_count integer;
  public_user_count integer;
  active_user_count integer;
  password_hash_count integer;
  auth_user_count integer;
  other_membership_count integer;
  customer_count integer;
  project_count integer;
  team_count integer;
  report_count integer;
  assignment_count integer;
  unexpected_scoped_count integer;
  private_state_count integer;
  storage_count integer;
  cross_tenant_reference_count integer;
  external_snapshot_reference_count integer;
  owner_identity_match_count integer;
  company_field_match boolean;
  customer_coverage_count integer;
  project_coverage_count integer;
  team_coverage_count integer;
  report_coverage_count integer;
  assignment_coverage_count integer;
  survivor_user_count integer;
  survivor_customer_count integer;
  survivor_project_count integer;
  survivor_team_count integer;
  survivor_report_count integer;
  survivor_assignment_count integer;
  ready boolean;
  archived_exact boolean;
BEGIN
  IF p_archived_at IS NULL THEN
    RAISE EXCEPTION 'PDL_ARTIFACT_ARCHIVE_TIME_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO target_company
  FROM public.companies
  WHERE id = target_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PDL_ARTIFACT_TARGET_MISSING' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO survivor_company
  FROM public.companies
  WHERE id = survivor_id;
  IF NOT FOUND OR survivor_company.data IS NULL OR
     jsonb_typeof(survivor_company.data) <> 'object' OR
     jsonb_typeof(survivor_company.data->'company') <> 'object' THEN
    RAISE EXCEPTION 'PDL_ARTIFACT_SURVIVOR_INVALID' USING ERRCODE = '55000';
  END IF;

  target_ref := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to('pdl-artifact-ref:v1:' || target_id::text, 'UTF8'), 'sha256'),
    'hex'
  );
  survivor_ref := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to('pdl-artifact-ref:v1:' || survivor_id::text, 'UTF8'), 'sha256'),
    'hex'
  );

  -- The document is intentionally never returned.  It allows evidence to
  -- bind every preserved row without exposing customer names, contacts,
  -- notes, password fields, object keys, or other tenant content.
  SELECT jsonb_build_object(
    'companyMetadata', jsonb_build_object(
      'id', target_company.id,
      'slug', target_company.slug,
      'name', target_company.name,
      'createdAt', target_company.created_at
    ),
    'users', COALESCE((
      SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id)
      FROM public.users AS u
      WHERE u.id IN (
        SELECT m.user_id FROM public.memberships AS m WHERE m.company_id = target_id
      )
    ), '[]'::jsonb),
    'authUsers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', au.id,
        'createdAt', au.created_at,
        'updatedAt', au.updated_at,
        'lastSignInAt', au.last_sign_in_at,
        'deletedAt', au.deleted_at
      ) ORDER BY au.id)
      FROM auth.users AS au
      WHERE au.id IN (
        SELECT m.user_id FROM public.memberships AS m WHERE m.company_id = target_id
      )
    ), '[]'::jsonb),
    'memberships', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.memberships x WHERE x.company_id=target_id), '[]'::jsonb),
    'customers', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.customers x WHERE x.company_id=target_id), '[]'::jsonb),
    'projects', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.projects x WHERE x.company_id=target_id), '[]'::jsonb),
    'teamMembers', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.team_members x WHERE x.company_id=target_id), '[]'::jsonb),
    'subcontractors', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.subcontractors x WHERE x.company_id=target_id), '[]'::jsonb),
    'reports', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.reports x WHERE x.company_id=target_id), '[]'::jsonb),
    'photos', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.photos x WHERE x.company_id=target_id), '[]'::jsonb),
    'assignments', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.assignments x WHERE x.company_id=target_id), '[]'::jsonb),
    'workdays', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.workdays x WHERE x.company_id=target_id), '[]'::jsonb),
    'changes', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.changes x WHERE x.company_id=target_id), '[]'::jsonb),
    'guestLinks', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.guest_links x WHERE x.company_id=target_id), '[]'::jsonb),
    'auditEvents', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM public.audit_events x WHERE x.company_id=target_id), '[]'::jsonb),
    'tenantRevisions', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.company_id) FROM public.tenant_revisions x WHERE x.company_id=target_id), '[]'::jsonb),
    'tenantRecords', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.collection,x.position,x.record_key) FROM public.tenant_records x WHERE x.company_id=target_id), '[]'::jsonb),
    'tenantDirectory', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.company_id) FROM private.tenant_directory x WHERE x.company_id=target_id), '[]'::jsonb),
    'tenantEmails', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.normalized_email) FROM private.tenant_active_user_emails x WHERE x.company_id=target_id), '[]'::jsonb),
    'tenantLinkTokens', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.token_hash) FROM private.tenant_public_link_tokens x WHERE x.company_id=target_id), '[]'::jsonb),
    'tenantTombstones', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.company_id) FROM private.tenant_tombstones x WHERE x.company_id=target_id), '[]'::jsonb),
    'tenantDeletionOperations', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.company_id) FROM private.tenant_deletion_operations x WHERE x.company_id=target_id), '[]'::jsonb),
    'tenantDeletionFinalizers', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.company_id) FROM private.tenant_deletion_finalizers x WHERE x.company_id=target_id), '[]'::jsonb),
    'storageObjects', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', x.id,
        'bucketId', x.bucket_id,
        'name', x.name,
        'ownerId', x.owner_id,
        'createdAt', x.created_at,
        'updatedAt', x.updated_at,
        'metadata', x.metadata,
        'userMetadata', x.user_metadata
      ) ORDER BY x.bucket_id,x.name)
      FROM storage.objects x WHERE x.name LIKE target_id::text || '/%'
    ), '[]'::jsonb)
  ) INTO preserved_document;

  preserved_sha := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(preserved_document::text, 'UTF8'), 'sha256'), 'hex'
  );
  survivor_sha := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(survivor_company.data::text, 'UTF8'), 'sha256'), 'hex'
  );
  preimage_sha := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(jsonb_build_object(
      'targetData', target_company.data,
      'preservedRowsSha256', preserved_sha,
      'survivorSnapshotSha256', survivor_sha
    )::text, 'UTF8'), 'sha256'), 'hex'
  );

  archive_data := jsonb_build_object(
    'version', 2,
    'company', jsonb_build_object(
      'id', target_id::text,
      'name', target_company.name,
      'archivedDuplicate', true,
      'archivedAt', to_char(p_archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'archivedReason', 'Legacy normalized migration artifact quarantined before transactional cutover'
    ),
    'artifactQuarantine', jsonb_build_object(
      'schema', 'pdl-legacy-normalized-artifact-quarantine/v1',
      'survivingTenantRef', survivor_ref,
      'preservedRowsSha256', preserved_sha
    )
  );
  archive_sha := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(archive_data::text, 'UTF8'), 'sha256'), 'hex'
  );

  classification := CASE
    WHEN target_company.data = '{}'::jsonb THEN 'malformed-empty'
    WHEN target_company.data = archive_data THEN 'archived-quarantine'
    ELSE 'drift'
  END;
  archived_exact := classification = 'archived-quarantine';

  SELECT count(*)::integer,
         count(DISTINCT u.id)::integer,
         count(DISTINCT u.id) FILTER (WHERE lower(COALESCE(u.status,''))='active')::integer,
         count(DISTINCT u.id) FILTER (WHERE NULLIF(u.password_hash,'') IS NOT NULL)::integer
  INTO membership_count,public_user_count,active_user_count,password_hash_count
  FROM public.memberships m
  LEFT JOIN public.users u ON u.id=m.user_id
  WHERE m.company_id=target_id;

  SELECT count(*)::integer INTO auth_user_count
  FROM auth.users au
  WHERE au.id IN (SELECT m.user_id FROM public.memberships m WHERE m.company_id=target_id);
  SELECT count(*)::integer INTO other_membership_count
  FROM public.memberships m
  WHERE m.user_id IN (SELECT tm.user_id FROM public.memberships tm WHERE tm.company_id=target_id)
    AND m.company_id<>target_id;

  SELECT count(*)::integer INTO customer_count FROM public.customers WHERE company_id=target_id;
  SELECT count(*)::integer INTO project_count FROM public.projects WHERE company_id=target_id;
  SELECT count(*)::integer INTO team_count FROM public.team_members WHERE company_id=target_id;
  SELECT count(*)::integer INTO report_count FROM public.reports WHERE company_id=target_id;
  SELECT count(*)::integer INTO assignment_count FROM public.assignments WHERE company_id=target_id;

  SELECT
    (SELECT count(*) FROM public.subcontractors WHERE company_id=target_id) +
    (SELECT count(*) FROM public.photos WHERE company_id=target_id) +
    (SELECT count(*) FROM public.workdays WHERE company_id=target_id) +
    (SELECT count(*) FROM public.changes WHERE company_id=target_id) +
    (SELECT count(*) FROM public.guest_links WHERE company_id=target_id) +
    (SELECT count(*) FROM public.audit_events WHERE company_id=target_id)
  INTO unexpected_scoped_count;

  SELECT
    (SELECT count(*) FROM public.tenant_revisions WHERE company_id=target_id) +
    (SELECT count(*) FROM public.tenant_records WHERE company_id=target_id) +
    (SELECT count(*) FROM private.tenant_directory WHERE company_id=target_id) +
    (SELECT count(*) FROM private.tenant_active_user_emails WHERE company_id=target_id) +
    (SELECT count(*) FROM private.tenant_public_link_tokens WHERE company_id=target_id) +
    (SELECT count(*) FROM private.tenant_tombstones WHERE company_id=target_id) +
    (SELECT count(*) FROM private.tenant_deletion_operations WHERE company_id=target_id) +
    (SELECT count(*) FROM private.tenant_deletion_finalizers WHERE company_id=target_id)
  INTO private_state_count;
  SELECT count(*)::integer INTO storage_count
  FROM storage.objects WHERE name LIKE target_id::text || '/%';

  SELECT
    (SELECT count(*) FROM public.projects p WHERE p.company_id<>target_id AND p.customer_id IN (SELECT id FROM public.customers WHERE company_id=target_id)) +
    (SELECT count(*) FROM public.reports r WHERE r.company_id<>target_id AND r.project_id IN (SELECT id FROM public.projects WHERE company_id=target_id)) +
    (SELECT count(*) FROM public.photos r WHERE r.company_id<>target_id AND (r.project_id IN (SELECT id FROM public.projects WHERE company_id=target_id) OR r.report_id IN (SELECT id FROM public.reports WHERE company_id=target_id))) +
    (SELECT count(*) FROM public.assignments r WHERE r.company_id<>target_id AND r.project_id IN (SELECT id FROM public.projects WHERE company_id=target_id)) +
    (SELECT count(*) FROM public.workdays r WHERE r.company_id<>target_id AND r.project_id IN (SELECT id FROM public.projects WHERE company_id=target_id)) +
    (SELECT count(*) FROM public.changes r WHERE r.company_id<>target_id AND (r.project_id IN (SELECT id FROM public.projects WHERE company_id=target_id) OR r.report_id IN (SELECT id FROM public.reports WHERE company_id=target_id))) +
    (SELECT count(*) FROM public.guest_links r WHERE r.company_id<>target_id AND r.project_id IN (SELECT id FROM public.projects WHERE company_id=target_id)) +
    (SELECT count(*) FROM public.reports r WHERE r.company_id<>target_id AND r.submitted_by IN (SELECT user_id FROM public.memberships WHERE company_id=target_id)) +
    (SELECT count(*) FROM public.audit_events r WHERE r.company_id<>target_id AND r.actor_user_id IN (SELECT user_id FROM public.memberships WHERE company_id=target_id))
  INTO cross_tenant_reference_count;

  SELECT count(*)::integer INTO external_snapshot_reference_count
  FROM public.companies c
  WHERE c.id<>target_id
    AND position(target_id::text IN c.data::text)>0;

  SELECT count(*)::integer INTO owner_identity_match_count
  FROM public.memberships m
  JOIN public.users u ON u.id=m.user_id
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(survivor_company.data->'users')='array'
      THEN survivor_company.data->'users' ELSE '[]'::jsonb END
  ) j
  WHERE m.company_id=target_id AND m.role='owner'
    AND lower(btrim(j->>'email'))=lower(btrim(u.email));

  company_field_match :=
    lower(btrim(survivor_company.data->'company'->>'name'))=lower(btrim(target_company.name)) AND
    lower(btrim(survivor_company.data->'company'->>'id'))=lower(btrim(target_company.slug)) AND
    COALESCE((survivor_company.data->'company'->>'archivedDuplicate')::boolean,false)=false AND
    NULLIF(btrim(survivor_company.data->'company'->>'deletedAt'),'') IS NULL;

  SELECT count(*)::integer INTO customer_coverage_count
  FROM public.customers x
  WHERE x.company_id=target_id AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(survivor_company.data->'customers')='array'
        THEN survivor_company.data->'customers' ELSE '[]'::jsonb END
    ) j
    WHERE lower(btrim(j->>'name'))=lower(btrim(x.name))
      AND lower(btrim(COALESCE(j->>'contact','')))=lower(btrim(COALESCE(x.contact->>'name','')))
      AND lower(btrim(COALESCE(j->>'email','')))=lower(btrim(COALESCE(x.contact->>'email','')))
      AND regexp_replace(COALESCE(j->>'phone',''),'\D','','g')=regexp_replace(COALESCE(x.contact->>'phone',''),'\D','','g')
  );
  SELECT count(*)::integer INTO project_coverage_count FROM public.projects x WHERE x.company_id=target_id AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(survivor_company.data->'projects')='array' THEN survivor_company.data->'projects' ELSE '[]'::jsonb END) j WHERE j->>'id'=x.data->>'legacyId'
  );
  SELECT count(*)::integer INTO team_coverage_count FROM public.team_members x WHERE x.company_id=target_id AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(survivor_company.data->'team')='array' THEN survivor_company.data->'team' ELSE '[]'::jsonb END) j WHERE j->>'id'=x.data->>'legacyId'
  );
  SELECT count(*)::integer INTO report_coverage_count FROM public.reports x WHERE x.company_id=target_id AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(survivor_company.data->'reports')='array' THEN survivor_company.data->'reports' ELSE '[]'::jsonb END) j WHERE j->>'id'=x.data->>'legacyId'
  );
  SELECT count(*)::integer INTO assignment_coverage_count FROM public.assignments x WHERE x.company_id=target_id AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(survivor_company.data->'assignments')='array' THEN survivor_company.data->'assignments' ELSE '[]'::jsonb END) j WHERE j->>'id'=x.data->>'legacyId'
  );

  survivor_user_count := jsonb_array_length(CASE WHEN jsonb_typeof(survivor_company.data->'users')='array' THEN survivor_company.data->'users' ELSE '[]'::jsonb END);
  survivor_customer_count := jsonb_array_length(CASE WHEN jsonb_typeof(survivor_company.data->'customers')='array' THEN survivor_company.data->'customers' ELSE '[]'::jsonb END);
  survivor_project_count := jsonb_array_length(CASE WHEN jsonb_typeof(survivor_company.data->'projects')='array' THEN survivor_company.data->'projects' ELSE '[]'::jsonb END);
  survivor_team_count := jsonb_array_length(CASE WHEN jsonb_typeof(survivor_company.data->'team')='array' THEN survivor_company.data->'team' ELSE '[]'::jsonb END);
  survivor_report_count := jsonb_array_length(CASE WHEN jsonb_typeof(survivor_company.data->'reports')='array' THEN survivor_company.data->'reports' ELSE '[]'::jsonb END);
  survivor_assignment_count := jsonb_array_length(CASE WHEN jsonb_typeof(survivor_company.data->'assignments')='array' THEN survivor_company.data->'assignments' ELSE '[]'::jsonb END);

  ready := classification='malformed-empty' AND
    membership_count=1 AND public_user_count=1 AND active_user_count=1 AND
    password_hash_count=0 AND auth_user_count=0 AND other_membership_count=0 AND
    customer_count=5 AND project_count=6 AND team_count=8 AND report_count=5 AND assignment_count=4 AND
    unexpected_scoped_count=0 AND private_state_count=0 AND storage_count=0 AND
    cross_tenant_reference_count=0 AND external_snapshot_reference_count=0 AND
    owner_identity_match_count=1 AND company_field_match AND
    customer_coverage_count=customer_count AND project_coverage_count=project_count AND
    team_coverage_count=team_count AND report_coverage_count=report_count AND
    assignment_coverage_count=assignment_count AND
    survivor_user_count>=public_user_count AND survivor_customer_count>=customer_count AND
    survivor_project_count>=project_count AND survivor_team_count>=team_count AND
    survivor_report_count>=report_count AND survivor_assignment_count>=assignment_count;

  RETURN jsonb_build_object(
    'schema','pdl-legacy-normalized-artifact-state/v1',
    'targetRef',target_ref,
    'survivingTenantRef',survivor_ref,
    'classification',classification,
    'readyForQuarantine',ready,
    'archiveSnapshotExact',archived_exact,
    'preimageSha256',preimage_sha,
    'preservedRowsSha256',preserved_sha,
    'survivorSnapshotSha256',survivor_sha,
    'archiveDataSha256',archive_sha,
    'createdAt',target_company.created_at,
    'counts',jsonb_build_object(
      'memberships',membership_count,
      'publicUsers',public_user_count,
      'customers',customer_count,
      'projects',project_count,
      'teamMembers',team_count,
      'reports',report_count,
      'assignments',assignment_count,
      'unexpectedScoped',unexpected_scoped_count,
      'privateOrTransactional',private_state_count,
      'storageObjects',storage_count,
      'crossTenantReferences',cross_tenant_reference_count,
      'externalSnapshotReferences',external_snapshot_reference_count
    ),
    'identity',jsonb_build_object(
      'activePublicUsers',active_user_count,
      'passwordHashesPresent',password_hash_count,
      'authUsers',auth_user_count,
      'otherMemberships',other_membership_count,
      'ownerSnapshotMatches',owner_identity_match_count,
      'companyFieldsMatch',company_field_match
    ),
    'coverage',jsonb_build_object(
      'customers',customer_coverage_count,
      'projects',project_coverage_count,
      'teamMembers',team_coverage_count,
      'reports',report_coverage_count,
      'assignments',assignment_coverage_count
    ),
    'survivorCounts',jsonb_build_object(
      'users',survivor_user_count,
      'customers',survivor_customer_count,
      'projects',survivor_project_count,
      'teamMembers',survivor_team_count,
      'reports',survivor_report_count,
      'assignments',survivor_assignment_count
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION private.pdl_legacy_normalized_artifact_state(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.inspect_legacy_normalized_artifact(
  p_archived_at timestamptz
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
SET statement_timeout = '30s'
AS $$
  SELECT private.pdl_legacy_normalized_artifact_state(p_archived_at)
$$;

CREATE OR REPLACE FUNCTION public.quarantine_legacy_normalized_artifact(
  p_archived_at timestamptz,
  p_expected_preimage_sha256 text,
  p_expected_preserved_rows_sha256 text,
  p_expected_archive_data_sha256 text,
  p_confirmation text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $$
DECLARE
  target_id constant uuid := '86479331-4c63-5cc3-8633-a8d7fd5751b3';
  confirmation constant text := 'QUARANTINE EXACT LEGACY NORMALIZED ARTIFACT';
  before_state jsonb;
  after_state jsonb;
  target_name text;
  archive_data jsonb;
  updated_count integer;
BEGIN
  IF p_confirmation IS DISTINCT FROM confirmation THEN
    RAISE EXCEPTION 'PDL_ARTIFACT_CONFIRMATION_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF p_archived_at IS NULL OR
     p_expected_preimage_sha256 !~ '^[a-f0-9]{64}$' OR
     p_expected_preserved_rows_sha256 !~ '^[a-f0-9]{64}$' OR
     p_expected_archive_data_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'PDL_ARTIFACT_PAYLOAD_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_id::text,0));
  SELECT name INTO target_name
  FROM public.companies
  WHERE id=target_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PDL_ARTIFACT_TARGET_MISSING' USING ERRCODE = '55000';
  END IF;

  before_state := private.pdl_legacy_normalized_artifact_state(p_archived_at);
  IF before_state->>'classification'<>'malformed-empty' OR
     COALESCE((before_state->>'readyForQuarantine')::boolean,false)<>true THEN
    RAISE EXCEPTION 'PDL_ARTIFACT_PRECONDITION_FAILED' USING ERRCODE = '55000';
  END IF;
  IF before_state->>'preimageSha256'<>p_expected_preimage_sha256 OR
     before_state->>'preservedRowsSha256'<>p_expected_preserved_rows_sha256 OR
     before_state->>'archiveDataSha256'<>p_expected_archive_data_sha256 THEN
    RAISE EXCEPTION 'PDL_ARTIFACT_PREIMAGE_CHANGED' USING ERRCODE = 'PT409';
  END IF;

  archive_data := jsonb_build_object(
    'version',2,
    'company',jsonb_build_object(
      'id',target_id::text,
      'name',target_name,
      'archivedDuplicate',true,
      'archivedAt',to_char(p_archived_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'archivedReason','Legacy normalized migration artifact quarantined before transactional cutover'
    ),
    'artifactQuarantine',jsonb_build_object(
      'schema','pdl-legacy-normalized-artifact-quarantine/v1',
      'survivingTenantRef',before_state->>'survivingTenantRef',
      'preservedRowsSha256',before_state->>'preservedRowsSha256'
    )
  );

  IF pg_catalog.encode(extensions.digest(pg_catalog.convert_to(archive_data::text,'UTF8'),'sha256'),'hex')
       <> p_expected_archive_data_sha256 THEN
    RAISE EXCEPTION 'PDL_ARTIFACT_ARCHIVE_PAYLOAD_CHANGED' USING ERRCODE = 'PT409';
  END IF;

  UPDATE public.companies
  SET data=archive_data
  WHERE id=target_id AND data='{}'::jsonb;
  GET DIAGNOSTICS updated_count=ROW_COUNT;
  IF updated_count<>1 THEN
    RAISE EXCEPTION 'PDL_ARTIFACT_COMPARE_AND_SWAP_FAILED' USING ERRCODE = 'PT409';
  END IF;

  after_state := private.pdl_legacy_normalized_artifact_state(p_archived_at);
  IF after_state->>'classification'<>'archived-quarantine' OR
     COALESCE((after_state->>'archiveSnapshotExact')::boolean,false)<>true OR
     after_state->>'preservedRowsSha256'<>p_expected_preserved_rows_sha256 OR
     after_state->>'archiveDataSha256'<>p_expected_archive_data_sha256 THEN
    RAISE EXCEPTION 'PDL_ARTIFACT_POSTWRITE_VERIFICATION_FAILED' USING ERRCODE = 'PT409';
  END IF;

  RETURN jsonb_build_object(
    'status','quarantined',
    'classification',after_state->>'classification',
    'targetRef',after_state->>'targetRef',
    'survivingTenantRef',after_state->>'survivingTenantRef',
    'preservedRowsSha256',after_state->>'preservedRowsSha256',
    'archiveDataSha256',after_state->>'archiveDataSha256'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.inspect_legacy_normalized_artifact(timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.quarantine_legacy_normalized_artifact(timestamptz,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inspect_legacy_normalized_artifact(timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.quarantine_legacy_normalized_artifact(timestamptz,text,text,text,text)
  TO service_role;

-- Deployment evidence: browser roles must be false; service_role must be true.
WITH functions AS (
  SELECT p.oid,p.proname,p.proacl,p.proowner
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN('inspect_legacy_normalized_artifact','quarantine_legacy_normalized_artifact')
)
SELECT functions.proname,roles.role_name,
       CASE WHEN roles.role_name='PUBLIC' THEN EXISTS(
         SELECT 1 FROM pg_catalog.aclexplode(COALESCE(functions.proacl,pg_catalog.acldefault('f',functions.proowner))) acl
         WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
       ) ELSE COALESCE((
         SELECT pg_catalog.has_function_privilege(r.oid,functions.oid,'EXECUTE')
         FROM pg_catalog.pg_roles r WHERE r.rolname=roles.role_name
       ),false) END AS can_execute
FROM functions
CROSS JOIN (VALUES('PUBLIC'::text),('anon'),('authenticated'),('service_role')) roles(role_name)
ORDER BY functions.proname,roles.role_name;

COMMIT;
