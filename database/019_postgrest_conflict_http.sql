BEGIN;

-- PostgREST 14 retries SQLSTATE 40001 because PostgreSQL reserves it for a
-- genuine serialization failure. These three server-only RPCs use revision
-- mismatches as ordinary application conflicts, so expose them as HTTP 409
-- with PostgREST's PT409 SQLSTATE instead. This forward repair is deliberately
-- limited to the exact production definitions verified on 2026-10-21.
--
-- The migration is idempotent: it accepts either the verified pre-repair
-- fingerprint or the exact repaired fingerprint and refuses every other body,
-- owner, execution attribute, search path, or privilege shape. It never
-- rewrites a function whose production definition has drifted.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  target_signatures constant text[] := ARRAY[
    'public.begin_tenant_repository_purge(uuid,bigint,uuid)',
    'public.replace_platform_repository(uuid,bigint,jsonb,text,jsonb,text)',
    'public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb)'
  ];
  expected_results constant text[] := ARRAY[
    'jsonb',
    'jsonb',
    'TABLE(revision bigint, record_count bigint)'
  ];
  verified_before_md5 constant text[] := ARRAY[
    'f55fc7def03b08da552d6ee9ca899868',
    '7782c7a8122c4ceb661549cb4e60b8e1',
    'aa6fe7d126442c3b63531c5acf9b6422'
  ];
  verified_after_md5 constant text[] := ARRAY[
    '3f68316cbde2368fc7c651cd238132b1',
    '7a7956d473365b5c1918bcca918dc653',
    'ce14e1d33490c9d77dccd9f6ff472512'
  ];
  target_index integer;
  target_oid oid;
  target_definition text;
  target_md5 text;
  target_owner text;
  target_language text;
  target_result text;
  target_volatility "char";
  target_parallel "char";
  target_strict boolean;
  target_security_definer boolean;
  target_config text[];
  target_acl text;
  public_execute boolean;
BEGIN
  FOR target_index IN 1..array_length(target_signatures, 1) LOOP
    target_oid := to_regprocedure(target_signatures[target_index]);
    IF target_oid IS NULL THEN
      RAISE EXCEPTION 'PDL_PT409_REPAIR_FUNCTION_MISSING signature=%',
        target_signatures[target_index]
        USING ERRCODE = '55000';
    END IF;

    SELECT
      pg_get_functiondef(proc.oid),
      md5(pg_get_functiondef(proc.oid)),
      pg_get_userbyid(proc.proowner),
      language.lanname,
      pg_get_function_result(proc.oid),
      proc.provolatile,
      proc.proparallel,
      proc.proisstrict,
      proc.prosecdef,
      proc.proconfig,
      proc.proacl::text,
      EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            proc.proacl,
            pg_catalog.acldefault('f', proc.proowner)
          )
        ) AS privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
      )
    INTO
      target_definition,
      target_md5,
      target_owner,
      target_language,
      target_result,
      target_volatility,
      target_parallel,
      target_strict,
      target_security_definer,
      target_config,
      target_acl,
      public_execute
    FROM pg_catalog.pg_proc AS proc
    JOIN pg_catalog.pg_language AS language
      ON language.oid = proc.prolang
    WHERE proc.oid = target_oid;

    IF target_owner <> 'postgres'
       OR target_language <> 'plpgsql'
       OR target_result <> expected_results[target_index]
       OR target_volatility <> 'v'
       OR target_parallel <> 'u'
       OR target_strict
       OR NOT target_security_definer
       OR COALESCE(target_config, ARRAY[]::text[]) <> ARRAY['search_path=""']::text[]
       OR target_acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
       OR public_execute
       OR NOT has_function_privilege('service_role', target_oid, 'EXECUTE')
       OR has_function_privilege('anon', target_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', target_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'PDL_PT409_REPAIR_METADATA_DRIFT signature=%',
        target_signatures[target_index]
        USING ERRCODE = '55000';
    END IF;

    IF target_md5 = verified_after_md5[target_index] THEN
      IF regexp_count(target_definition, '''40001''') <> 0
         OR regexp_count(target_definition, '''PT409''') <> 1 THEN
        RAISE EXCEPTION 'PDL_PT409_REPAIR_INVALID_REPAIRED_BODY signature=%',
          target_signatures[target_index]
          USING ERRCODE = '55000';
      END IF;
      CONTINUE;
    END IF;

    IF target_md5 <> verified_before_md5[target_index]
       OR regexp_count(target_definition, '''40001''') <> 1
       OR regexp_count(target_definition, '''PT409''') <> 0 THEN
      RAISE EXCEPTION 'PDL_PT409_REPAIR_DEFINITION_DRIFT signature=% md5=%',
        target_signatures[target_index], target_md5
        USING ERRCODE = '55000';
    END IF;

    EXECUTE replace(target_definition, '''40001''', '''PT409''');

    SELECT md5(pg_get_functiondef(target_oid))
    INTO target_md5;
    IF target_md5 <> verified_after_md5[target_index]
       OR regexp_count(pg_get_functiondef(target_oid), '''40001''') <> 0
       OR regexp_count(pg_get_functiondef(target_oid), '''PT409''') <> 1 THEN
      RAISE EXCEPTION 'PDL_PT409_REPAIR_POSTCONDITION_FAILED signature=% md5=%',
        target_signatures[target_index], target_md5
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Deployment evidence: all three rows must report the repaired fingerprint,
-- zero custom 40001 literals, exactly one PT409 literal, service-role access,
-- and no browser-role access.
SELECT
  proc.oid::regprocedure::text AS signature,
  md5(pg_get_functiondef(proc.oid)) AS definition_md5,
  regexp_count(proc.prosrc, '40001') AS custom_40001_count,
  regexp_count(proc.prosrc, 'PT409') AS pt409_count,
  proc.proacl::text AS exact_acl,
  has_function_privilege('service_role', proc.oid, 'EXECUTE') AS service_role_execute,
  has_function_privilege('anon', proc.oid, 'EXECUTE') AS anon_execute,
  has_function_privilege('authenticated', proc.oid, 'EXECUTE') AS authenticated_execute
FROM pg_catalog.pg_proc AS proc
WHERE proc.oid IN (
  'public.begin_tenant_repository_purge(uuid,bigint,uuid)'::regprocedure,
  'public.replace_platform_repository(uuid,bigint,jsonb,text,jsonb,text)'::regprocedure,
  'public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb)'::regprocedure
)
ORDER BY signature;
