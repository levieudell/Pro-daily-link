BEGIN;

-- A permanent CAS mismatch must reach the caller once as HTTP 409.
-- SQLSTATE 40001 is retried internally by PostgREST's Hasql transaction runner.
-- Preserve the installed function body, settings, owner and existing privileges.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5s';

DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb)'::regprocedure);
  old_raise text := 'RAISE EXCEPTION ''PDL_REVISION_CONFLICT expected=% actual=%'', p_expected_revision, current_revision USING ERRCODE = ''40001'';';
  new_raise text := 'RAISE EXCEPTION ''PDL_REVISION_CONFLICT expected=% actual=%'', p_expected_revision, current_revision USING ERRCODE = ''PT409'';';
BEGIN
  IF strpos(definition, old_raise) = 0 THEN
    IF strpos(definition, new_raise) > 0 THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'Refusing revision-conflict migration: expected exception clause was not found';
  END IF;
  IF (length(definition) - length(replace(definition, old_raise, ''))) <> length(old_raise) THEN
    RAISE EXCEPTION 'Refusing revision-conflict migration: exception clause is not unique';
  END IF;
  EXECUTE replace(definition, old_raise, new_raise);
END;
$migration$;

COMMIT;
