BEGIN;

-- Prepared incident correction only. Requires owner approval before production use.
-- Keep other function DDL and deployments on hold during this short transaction.
-- Snapshot verified 2026-10-07 12:26:18.470622 UTC; verify again before applying.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5s';

DO $migration$
DECLARE
  function_oid oid := 'public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb)'::regprocedure;
  definition text := pg_get_functiondef(function_oid);
  old_raise text := 'RAISE EXCEPTION ''PDL_REVISION_CONFLICT expected=% actual=%'', p_expected_revision, current_revision USING ERRCODE = ''40001'';';
  new_raise text := 'RAISE EXCEPTION ''PDL_REVISION_CONFLICT expected=% actual=%'', p_expected_revision, current_revision USING ERRCODE = ''PT409'';';
  source_fingerprint constant text := '42754c22067175058ce461c883b566f5';
  body_fingerprint constant text := 'ddf8908236dab9994ca44522abbbfd73';
  metadata_ok boolean;
BEGIN
  -- Normalize only this exact clause to support an already-applied no-op.
  -- Unrelated source or permission changes fail closed, including on a no-op.
  IF md5(replace(definition, new_raise, old_raise)) <> source_fingerprint THEN
    RAISE EXCEPTION 'Refusing incident correction: deployed function definition fingerprint differs';
  END IF;
  SELECT md5(replace(p.prosrc, new_raise, old_raise)) = body_fingerprint
     AND p.proowner::regrole::text = 'postgres'
     AND p.prosecdef
     AND p.proconfig = ARRAY['search_path=public']::text[]
     AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
    INTO metadata_ok
    FROM pg_proc p WHERE p.oid = function_oid;
  IF metadata_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Refusing incident correction: function body, ownership, settings or grants differ';
  END IF;
  IF strpos(definition, old_raise) = 0 THEN
    IF strpos(definition, new_raise) > 0 THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'Refusing incident correction: expected exception clause was not found';
  END IF;
  IF (length(definition) - length(replace(definition, old_raise, ''))) <> length(old_raise) THEN
    RAISE EXCEPTION 'Refusing incident correction: exception clause is not unique';
  END IF;

  EXECUTE replace(definition, old_raise, new_raise);

  IF pg_get_functiondef(function_oid) <> replace(definition, old_raise, new_raise) THEN
    RAISE EXCEPTION 'Refusing incident correction: post-change definition differs';
  END IF;
  SELECT md5(replace(p.prosrc, new_raise, old_raise)) = body_fingerprint
     AND p.proowner::regrole::text = 'postgres'
     AND p.prosecdef
     AND p.proconfig = ARRAY['search_path=public']::text[]
     AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
    INTO metadata_ok
    FROM pg_proc p WHERE p.oid = function_oid;
  IF metadata_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Refusing incident correction: post-change metadata differs';
  END IF;
END;
$migration$;

COMMIT;
