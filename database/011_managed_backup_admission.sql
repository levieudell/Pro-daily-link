BEGIN;
-- Server-only immutable custody precedes storage dispatch. No tenant activation,
-- company snapshot updates, browser policy, bucket change or global ACL change.
CREATE TABLE public.roles_managed_backup_jobs (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  job_key text NOT NULL,
  descriptor jsonb NOT NULL,
  admitted_until timestamptz NOT NULL,
  PRIMARY KEY(company_id,job_key)
);
ALTER TABLE public.roles_managed_backup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles_managed_backup_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.roles_managed_backup_jobs FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.managed_backup_job_writer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP<>'INSERT' OR current_setting('pdl.managed_backup_admission',true) IS DISTINCT FROM 'v1' THEN
    RAISE EXCEPTION 'PDL_BACKUP_IMMUTABLE_ADMISSION' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER managed_backup_job_writer BEFORE INSERT OR UPDATE OR DELETE ON public.roles_managed_backup_jobs
FOR EACH ROW EXECUTE FUNCTION public.managed_backup_job_writer_guard();

CREATE FUNCTION public.managed_backup_job_deadline_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF clock_timestamp()>=NEW.admitted_until THEN RAISE EXCEPTION 'PDL_BACKUP_ADMISSION_DEADLINE' USING ERRCODE='40001'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER managed_backup_job_deadline AFTER INSERT ON public.roles_managed_backup_jobs
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.managed_backup_job_deadline_guard();

CREATE FUNCTION public.managed_backup_job_contract() RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT (SELECT relrowsecurity AND relforcerowsecurity AND relkind='r' AND relpersistence='p' AND NOT relispartition
      AND relowner=(SELECT relowner FROM pg_class WHERE oid='public.companies'::regclass) FROM pg_class WHERE oid='public.roles_managed_backup_jobs'::regclass)
    AND (SELECT count(*)=4 FROM pg_attribute WHERE attrelid='public.roles_managed_backup_jobs'::regclass AND attnum>0 AND NOT attisdropped)
    AND (SELECT count(*)=4 FROM (VALUES (1,'company_id','uuid'),(2,'job_key','text'),(3,'descriptor','jsonb'),(4,'admitted_until','timestamp with time zone')) expected(number,name,type)
      JOIN pg_attribute a ON a.attrelid='public.roles_managed_backup_jobs'::regclass AND a.attnum=expected.number
      WHERE a.attname=expected.name AND a.atttypid=to_regtype(expected.type) AND a.attnotnull AND NOT a.attisdropped AND a.attidentity='' AND a.attgenerated='' AND a.atttypmod=-1
        AND NOT EXISTS(SELECT 1 FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum))
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.roles_managed_backup_jobs'::regclass AND contype='p' AND conkey=ARRAY[1,2]::smallint[] AND convalidated AND NOT condeferrable)
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.roles_managed_backup_jobs'::regclass AND contype='f' AND conkey=ARRAY[1]::smallint[] AND confrelid='public.companies'::regclass
      AND confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.companies'::regclass AND attname='id' AND NOT attisdropped)]::smallint[] AND confdeltype='r' AND convalidated AND NOT condeferrable)
    AND (SELECT count(*)=2 FROM pg_trigger WHERE tgrelid='public.roles_managed_backup_jobs'::regclass AND NOT tgisinternal
      AND ((tgname='managed_backup_job_writer' AND tgenabled='O' AND tgtype=31 AND tgfoid='public.managed_backup_job_writer_guard()'::regprocedure)
      OR (tgname='managed_backup_job_deadline' AND tgenabled='O' AND tgtype=5 AND tgdeferrable AND tginitdeferred AND tgfoid='public.managed_backup_job_deadline_guard()'::regprocedure))
      AND tgqual IS NULL AND tgnargs=0 AND tgattr=''::int2vector)
    AND NOT EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid='public.roles_managed_backup_jobs'::regclass AND a.grantee<>c.relowner)
    AND NOT EXISTS(SELECT 1 FROM pg_attribute column_acl JOIN pg_class c ON c.oid=column_acl.attrelid
      CROSS JOIN LATERAL aclexplode(CASE WHEN coalesce(cardinality(column_acl.attacl),0)=0 THEN NULL ELSE column_acl.attacl END) a
      WHERE c.oid='public.roles_managed_backup_jobs'::regclass AND column_acl.attnum>0 AND NOT column_acl.attisdropped AND a.grantee<>c.relowner)
    AND (SELECT count(*)=7 FROM (VALUES
      ('public.managed_backup_job_writer_guard()','plpgsql',false,'v',false),
      ('public.managed_backup_job_deadline_guard()','plpgsql',false,'v',false),
      ('public.managed_backup_job_contract()','sql',false,'s',false),
      ('public.managed_backup_job_source(uuid)','plpgsql',true,'v',false),
      ('public.read_managed_backup_job(uuid,text)','plpgsql',true,'v',true),
      ('public.list_managed_backup_jobs(uuid)','plpgsql',true,'v',true),
      ('public.admit_managed_backup_job(uuid,text,jsonb,timestamp with time zone)','plpgsql',true,'v',true)
    ) expected(signature,language,definer,volatility,service_execute)
    JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature) JOIN pg_language l ON l.oid=p.prolang
    WHERE l.lanname=expected.language AND p.prosecdef=expected.definer AND p.provolatile::text=expected.volatility AND p.prokind='f' AND NOT p.proretset
      AND p.proowner=(SELECT relowner FROM pg_class WHERE oid='public.roles_managed_backup_jobs'::regclass)
      AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR (a.grantee<>p.proowner AND (NOT expected.service_execute OR a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='service_role'))))
      AND has_function_privilege('service_role',p.oid,'EXECUTE')=expected.service_execute
      AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE'));
$$;

CREATE FUNCTION public.managed_backup_job_source(p_company_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF public.platform_snapshot_tenant_contract() IS DISTINCT FROM true OR public.platform_snapshot_trigger_contract() IS DISTINCT FROM true
    OR public.managed_backup_job_contract() IS DISTINCT FROM true THEN RAISE EXCEPTION 'PDL_BACKUP_ADMISSION_CONTRACT' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.companies WHERE id=p_company_id AND roles_managed=true AND platform_managed=false FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PDL_BACKUP_ADMISSION_SOURCE' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION public.read_managed_backup_job(p_company_id uuid,p_job_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.managed_backup_job_source(p_company_id);
  IF p_job_key IS NULL OR length(p_job_key)>200 OR p_job_key !~ ('^'||p_company_id::text||'/managed-v1/[0-9]{4}-[0-9]{2}-[0-9]{2}-(0|[1-9][0-9]*)-[a-f0-9]{64}$') THEN RAISE EXCEPTION 'PDL_BACKUP_ADMISSION_KEY' USING ERRCODE='23514'; END IF;
  SELECT descriptor INTO result FROM public.roles_managed_backup_jobs WHERE company_id=p_company_id AND job_key=p_job_key;
  RETURN result;
END $$;

CREATE FUNCTION public.list_managed_backup_jobs(p_company_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.managed_backup_job_source(p_company_id);
  SELECT coalesce(jsonb_agg(job_key ORDER BY job_key),'[]'::jsonb) INTO result FROM public.roles_managed_backup_jobs WHERE company_id=p_company_id;
  IF jsonb_array_length(result)>=3200 THEN RAISE EXCEPTION 'PDL_BACKUP_ADMISSION_CAPACITY' USING ERRCODE='23514'; END IF;
  RETURN result;
END $$;

CREATE FUNCTION public.admit_managed_backup_job(p_company_id uuid,p_job_key text,p_descriptor jsonb,p_deadline timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE existing jsonb; source_revision bigint;
BEGIN
  -- Serialize first admissions for a tenant; unique immutable keys and deferred
  -- deadlines ensure unknown RPC acknowledgements cannot create two originals.
  SELECT roles_revision INTO source_revision FROM public.companies WHERE id=p_company_id FOR UPDATE;
  PERFORM public.managed_backup_job_source(p_company_id);
  IF p_deadline IS NULL OR p_deadline<=clock_timestamp() OR p_deadline>clock_timestamp()+interval '5 seconds' THEN RAISE EXCEPTION 'PDL_BACKUP_ADMISSION_DEADLINE' USING ERRCODE='40001'; END IF;
  IF p_descriptor IS NULL OR jsonb_typeof(p_descriptor)<>'object' OR octet_length(p_descriptor::text)>4000000
    OR p_descriptor->>'format' IS DISTINCT FROM 'pdl-managed-backup-job-v1'
    OR p_descriptor->'core'->>'companyId' IS DISTINCT FROM p_company_id::text
    OR coalesce(p_descriptor->'core'->>'sourceRevision','') !~ '^(0|[1-9][0-9]*)$'
    OR (p_descriptor->'core'->>'sourceRevision')::numeric>source_revision
    OR p_job_key IS DISTINCT FROM p_company_id::text||'/managed-v1/'||left(p_descriptor->'core'->>'capturedAt',10)||'-'||(p_descriptor->'core'->>'sourceRevision')||'-'||(p_descriptor->'core'->'snapshot'->>'sha256')
    OR length(p_job_key)>200 OR p_job_key !~ ('^'||p_company_id::text||'/managed-v1/[0-9]{4}-[0-9]{2}-[0-9]{2}-(0|[1-9][0-9]*)-[a-f0-9]{64}$') THEN RAISE EXCEPTION 'PDL_BACKUP_ADMISSION_DESCRIPTOR' USING ERRCODE='23514'; END IF;
  SELECT descriptor INTO existing FROM public.roles_managed_backup_jobs WHERE company_id=p_company_id AND job_key=p_job_key;
  IF FOUND THEN RETURN existing; END IF;
  IF (SELECT count(*) FROM public.roles_managed_backup_jobs WHERE company_id=p_company_id)>=3199 THEN RAISE EXCEPTION 'PDL_BACKUP_ADMISSION_CAPACITY' USING ERRCODE='23514'; END IF;
  PERFORM set_config('pdl.managed_backup_admission','v1',true);
  INSERT INTO public.roles_managed_backup_jobs(company_id,job_key,descriptor,admitted_until) VALUES(p_company_id,p_job_key,p_descriptor,p_deadline);
  RETURN p_descriptor;
END $$;

REVOKE ALL ON FUNCTION public.managed_backup_job_writer_guard(),public.managed_backup_job_deadline_guard(),public.managed_backup_job_contract(),public.managed_backup_job_source(uuid),public.read_managed_backup_job(uuid,text),public.list_managed_backup_jobs(uuid),public.admit_managed_backup_job(uuid,text,jsonb,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.read_managed_backup_job(uuid,text),public.list_managed_backup_jobs(uuid),public.admit_managed_backup_job(uuid,text,jsonb,timestamptz) TO service_role;
COMMIT;
