-- Synthetic fixture schema only. Never a production migration or startup hook.
DO $$ BEGIN
  IF current_database() !~ '^(pdl_compat_|compat_test)' THEN
    RAISE EXCEPTION 'An explicitly named synthetic database is required';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.compat_tenant_deadline_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deadline text := NULLIF(current_setting('app.compat_tenant_deadline',true),'');
BEGIN
  IF deadline IS NOT NULL AND clock_timestamp() >= deadline::timestamptz THEN
    RAISE EXCEPTION 'Synthetic tenant authorization deadline expired' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compat_tenant_deadline ON public.tenant_revisions;
CREATE CONSTRAINT TRIGGER compat_tenant_deadline
AFTER INSERT OR UPDATE ON public.tenant_revisions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.compat_tenant_deadline_guard();
