-- Read-only service protocol probe. Source only; do not apply to production.
BEGIN;
CREATE OR REPLACE FUNCTION public.tenant_atomic_readiness(p_company_id uuid)
RETURNS TABLE(protocol_version integer, initialized boolean, mandatory_revision boolean, guarded_policy boolean, service_only boolean, forced_rls boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
WITH functions AS (
  SELECT p.oid, p.prosecdef, p.proacl, p.proowner, p.prosrc, p.prolang, p.proconfig, pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p WHERE p.oid IN (
    to_regprocedure('public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb)'),
    to_regprocedure('public.replace_tenant_policy_records(uuid,bigint,jsonb,text,jsonb,jsonb)'))
), permissions AS (
  SELECT count(*) = 2 AND bool_and(prosecdef AND prolang = (SELECT oid FROM pg_language WHERE lanname='plpgsql') AND proconfig IS NOT DISTINCT FROM ARRAY['search_path=public'])
    AND bool_and(has_function_privilege('service_role', oid, 'EXECUTE'))
    AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE') OR has_function_privilege('authenticated', oid, 'EXECUTE'))
    AND NOT EXISTS (SELECT 1 FROM functions f, LATERAL aclexplode(coalesce(f.proacl, acldefault('f',f.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS valid
  FROM functions
)
SELECT 1, EXISTS(SELECT 1 FROM public.tenant_revisions WHERE company_id=p_company_id AND revision>0 AND content_hash ~ '^[a-f0-9]{64}$'),
  EXISTS(SELECT 1 FROM functions WHERE oid=to_regprocedure('public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb)') AND md5(replace(prosrc,E'\r',''))='f9432f6072db04d5123bde276393dad9'),
  EXISTS(SELECT 1 FROM functions WHERE oid=to_regprocedure('public.replace_tenant_policy_records(uuid,bigint,jsonb,text,jsonb,jsonb)') AND md5(replace(prosrc,E'\r',''))='4fb3bc249bbdee9679deb0636427c024'),
  coalesce((SELECT valid FROM permissions),false),
  (SELECT count(*)=2 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE oid IN (to_regclass('public.tenant_revisions'),to_regclass('public.tenant_records')));
$$;
REVOKE ALL ON FUNCTION public.tenant_atomic_readiness(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_atomic_readiness(uuid) TO service_role;
COMMIT;
