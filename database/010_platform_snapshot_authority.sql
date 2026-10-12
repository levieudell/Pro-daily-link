-- SOURCE ONLY. Requires 009. No company is initialized or activated here.
-- The platform companies.data envelope and assistant-usage record namespace
-- share an ID, but deliberately have separate authorities and revisions.
BEGIN;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS platform_managed boolean NOT NULL DEFAULT false;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS platform_revision bigint NOT NULL DEFAULT 0 CHECK(platform_revision>=0 AND platform_revision<9007199254740991);

CREATE OR REPLACE FUNCTION public.platform_snapshot_envelope_valid(p_id uuid,p_snapshot jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT COALESCE(p_id='5a7f362f-e399-56e3-9458-e34b794a389d'::uuid
    AND jsonb_typeof(p_snapshot)='object' AND p_snapshot-'company'-'platform'='{}'::jsonb
    AND p_snapshot ? 'company' AND p_snapshot ? 'platform'
    AND jsonb_typeof(p_snapshot->'company')='object'
    AND (p_snapshot->'company')-'id'-'name'='{}'::jsonb
    AND p_snapshot->'company'->>'id'=p_id::text
    AND p_snapshot->'company'->>'name'='Pro Daily Link Platform Operations'
    AND jsonb_typeof(p_snapshot->'platform')='object',false)
$$;

CREATE OR REPLACE FUNCTION public.platform_snapshot_writer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE authority_owner name;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.platform_managed THEN RAISE EXCEPTION 'PDL_PLATFORM_MANAGED_DELETE_REQUIRES_RETENTION_REVIEW' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.platform_managed AND (NEW.roles_managed OR NOT public.platform_snapshot_envelope_valid(NEW.id,NEW.data)
    OR NEW.name IS DISTINCT FROM NEW.data->'company'->>'name') THEN
    RAISE EXCEPTION 'PDL_PLATFORM_INVALID_AUTHORITY' USING ERRCODE='23514';
  END IF;
  IF OLD.platform_managed THEN
    SELECT pg_get_userbyid(p.proowner) INTO authority_owner FROM pg_proc p WHERE p.oid='public.commit_platform_snapshot(uuid,bigint,jsonb,timestamp with time zone)'::regprocedure;
    IF current_user IS DISTINCT FROM authority_owner
      OR current_setting('app.platform_snapshot_commit',true) IS DISTINCT FROM OLD.id::text
      OR NEW.platform_revision IS DISTINCT FROM OLD.platform_revision+1
      OR (to_jsonb(NEW)-'data'-'name'-'platform_revision') IS DISTINCT FROM (to_jsonb(OLD)-'data'-'name'-'platform_revision') THEN
      RAISE EXCEPTION 'PDL_PLATFORM_LEGACY_WRITER_FENCED' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_snapshot_writer ON public.companies;
CREATE TRIGGER platform_snapshot_writer BEFORE UPDATE OR DELETE ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.platform_snapshot_writer_guard();

CREATE OR REPLACE FUNCTION public.platform_snapshot_deadline_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.platform_managed AND (NEW.data IS DISTINCT FROM OLD.data OR NEW.platform_revision IS DISTINCT FROM OLD.platform_revision) THEN
    IF NULLIF(current_setting('app.platform_snapshot_deadline',true),'') IS NULL
      OR clock_timestamp()>=current_setting('app.platform_snapshot_deadline',true)::timestamptz THEN
      RAISE EXCEPTION 'PDL_PLATFORM_DEADLINE' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_snapshot_deadline ON public.companies;
CREATE CONSTRAINT TRIGGER platform_snapshot_deadline AFTER UPDATE ON public.companies
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.platform_snapshot_deadline_guard();

CREATE OR REPLACE FUNCTION public.platform_snapshot_trigger_contract() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.companies'::regclass AND tgname='platform_snapshot_writer'
    AND tgfoid='public.platform_snapshot_writer_guard()'::regprocedure AND tgenabled='O' AND tgtype=27 AND NOT tgisinternal
    AND tgqual IS NULL AND tgnargs=0 AND tgattr=''::int2vector)
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.companies'::regclass AND tgname='platform_snapshot_deadline'
    AND tgfoid='public.platform_snapshot_deadline_guard()'::regprocedure AND tgdeferrable AND tginitdeferred AND tgenabled='O'
    AND tgtype=17 AND tgqual IS NULL AND tgnargs=0 AND tgattr=''::int2vector AND NOT tgisinternal)
  AND (SELECT count(*)=7 FROM (VALUES
    ('public.platform_snapshot_envelope_valid(uuid,jsonb)','sql',false,'i',false),
    ('public.platform_snapshot_writer_guard()','plpgsql',false,'v',false),
    ('public.platform_snapshot_deadline_guard()','plpgsql',false,'v',false),
    ('public.platform_snapshot_trigger_contract()','sql',false,'s',false),
    ('public.platform_snapshot_tenant_contract()','sql',false,'s',false),
    ('public.commit_platform_snapshot(uuid,bigint,jsonb,timestamptz)','plpgsql',true,'v',true),
    ('public.commit_roles_snapshot_with_platform(uuid,bigint,jsonb,timestamptz,uuid,bigint)','plpgsql',true,'v',true)
    ) expected(signature,language,definer,volatility,restricted)
    JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature) JOIN pg_language l ON l.oid=p.prolang
    WHERE l.lanname=expected.language AND p.prokind='f' AND p.prosecdef=expected.definer
      AND p.provolatile::text=expected.volatility AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
      AND p.proowner=(SELECT own.proowner FROM pg_proc own WHERE own.oid=to_regprocedure('public.commit_platform_snapshot(uuid,bigint,jsonb,timestamptz)'))
      AND p.proowner NOT IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role'))
      AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.privilege_type<>'EXECUTE' OR a.grantee<>p.proowner AND (expected.restricted
          AND (a.grantee IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname='service_role') OR a.is_grantable)
          OR NOT expected.restricted AND a.grantee<>0))
      AND (expected.restricted AND has_function_privilege('service_role',p.oid,'EXECUTE')
        AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
        OR NOT expected.restricted AND EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')))
$$;

CREATE OR REPLACE FUNCTION public.commit_platform_snapshot(p_platform_id uuid,p_expected_revision bigint,p_snapshot jsonb,p_deadline timestamptz)
RETURNS TABLE(revision bigint) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_revision bigint; current_snapshot jsonb; enabled boolean; tenant_managed boolean; original_deadline timestamptz;
BEGIN
  IF NOT public.platform_snapshot_envelope_valid(p_platform_id,p_snapshot) OR octet_length(p_snapshot::text)>16777216
    OR p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>=9007199254740990
    OR p_deadline IS NULL OR p_deadline>clock_timestamp()+interval '10 minutes' THEN
    RAISE EXCEPTION 'PDL_PLATFORM_INVALID_COMMIT' USING ERRCODE='22023';
  END IF;
  LOCK TABLE public.companies IN ROW EXCLUSIVE MODE;
  IF NOT public.platform_snapshot_trigger_contract() THEN RAISE EXCEPTION 'PDL_PLATFORM_TRIGGER_CONTRACT_REQUIRED' USING ERRCODE='23514'; END IF;
  SELECT c.platform_revision,c.data,c.platform_managed,c.roles_managed INTO current_revision,current_snapshot,enabled,tenant_managed
    FROM public.companies c WHERE c.id=p_platform_id FOR UPDATE;
  IF NOT FOUND OR NOT enabled OR tenant_managed OR NOT public.platform_snapshot_envelope_valid(p_platform_id,current_snapshot) THEN
    RAISE EXCEPTION 'PDL_PLATFORM_AUTHORITY_NOT_ENABLED' USING ERRCODE='23514';
  END IF;
  IF current_revision<>p_expected_revision THEN RAISE EXCEPTION 'PDL_REVISION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF clock_timestamp()>=p_deadline THEN RAISE EXCEPTION 'PDL_PLATFORM_DEADLINE' USING ERRCODE='40001'; END IF;
  original_deadline:=LEAST(p_deadline,NULLIF(current_setting('app.platform_snapshot_deadline',true),'')::timestamptz);
  PERFORM set_config('app.platform_snapshot_commit',p_platform_id::text,true);
  PERFORM set_config('app.platform_snapshot_deadline',original_deadline::text,true);
  UPDATE public.companies SET data=p_snapshot,name=p_snapshot->'company'->>'name',platform_revision=current_revision+1 WHERE id=p_platform_id;
  RETURN QUERY SELECT current_revision+1;
END $$;

-- A system-authorized tenant write pins the exact fresh shared-platform
-- revision until the tenant transaction commits. Platform lock is always first.
CREATE OR REPLACE FUNCTION public.commit_roles_snapshot_with_platform(p_company_id uuid,p_expected_revision bigint,p_snapshot jsonb,p_deadline timestamptz,p_platform_id uuid,p_platform_expected_revision bigint)
RETURNS TABLE(revision bigint) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_revision bigint; current_snapshot jsonb; enabled boolean; tenant_managed boolean;
BEGIN
  IF p_platform_id IS DISTINCT FROM '5a7f362f-e399-56e3-9458-e34b794a389d'::uuid
    OR p_company_id IS NULL OR p_company_id=p_platform_id OR p_snapshot->'company'->>'id' IS DISTINCT FROM p_company_id::text
    OR p_platform_expected_revision IS NULL OR p_platform_expected_revision<0 OR p_platform_expected_revision>=9007199254740991
    OR p_deadline IS NULL OR p_deadline>clock_timestamp()+interval '10 minutes' THEN
    RAISE EXCEPTION 'PDL_PLATFORM_INVALID_TENANT_COMMIT' USING ERRCODE='22023';
  END IF;
  LOCK TABLE public.companies IN ROW EXCLUSIVE MODE;
  IF NOT public.platform_snapshot_trigger_contract() OR NOT public.platform_snapshot_tenant_contract() THEN RAISE EXCEPTION 'PDL_PLATFORM_TRIGGER_CONTRACT_REQUIRED' USING ERRCODE='23514'; END IF;
  SELECT c.platform_revision,c.data,c.platform_managed,c.roles_managed INTO current_revision,current_snapshot,enabled,tenant_managed
    FROM public.companies c WHERE c.id=p_platform_id FOR SHARE;
  IF NOT FOUND OR NOT enabled OR tenant_managed OR NOT public.platform_snapshot_envelope_valid(p_platform_id,current_snapshot) THEN
    RAISE EXCEPTION 'PDL_PLATFORM_AUTHORITY_NOT_ENABLED' USING ERRCODE='23514';
  END IF;
  IF current_revision<>p_platform_expected_revision THEN RAISE EXCEPTION 'PDL_REVISION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF clock_timestamp()>=p_deadline THEN RAISE EXCEPTION 'PDL_PLATFORM_DEADLINE' USING ERRCODE='40001'; END IF;
  RETURN QUERY SELECT c.revision FROM public.commit_roles_snapshot(p_company_id,p_expected_revision,p_snapshot,p_deadline) c;
END $$;

REVOKE ALL ON FUNCTION public.commit_platform_snapshot(uuid,bigint,jsonb,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.commit_platform_snapshot(uuid,bigint,jsonb,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.commit_roles_snapshot_with_platform(uuid,bigint,jsonb,timestamptz,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.commit_roles_snapshot_with_platform(uuid,bigint,jsonb,timestamptz,uuid,bigint) TO service_role;

-- Check the unchanged 009 dependency's installed metadata without changing its
-- source or claiming a function-body fingerprint. Only cross-store CAS needs it.
CREATE OR REPLACE FUNCTION public.platform_snapshot_tenant_contract() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT count(*)=3 FROM (VALUES
    ('public.roles_snapshot_writer_guard()',false,false),
    ('public.roles_snapshot_deadline_guard()',false,false),
    ('public.commit_roles_snapshot(uuid,bigint,jsonb,timestamptz)',true,true)
    ) expected(signature,definer,restricted)
    JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature) JOIN pg_language l ON l.oid=p.prolang
    WHERE l.lanname='plpgsql' AND p.prokind='f' AND p.prosecdef=expected.definer AND p.provolatile='v'
      AND p.proconfig=ARRAY['search_path=public']::text[]
      AND p.proowner=(SELECT own.proowner FROM pg_proc own WHERE own.oid=to_regprocedure('public.commit_platform_snapshot(uuid,bigint,jsonb,timestamptz)'))
      AND (NOT expected.restricted OR has_function_privilege('service_role',p.oid,'EXECUTE')
        AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND (a.grantee IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname='service_role') OR a.is_grantable)))
$$;
COMMIT;
