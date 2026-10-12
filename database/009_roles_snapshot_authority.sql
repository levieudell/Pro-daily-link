-- SOURCE ONLY. Apply and activate named companies only after the owner's
-- separate migration/cutover approval. This does not activate any company.
BEGIN;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS roles_managed boolean NOT NULL DEFAULT false;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS roles_revision bigint NOT NULL DEFAULT 0 CHECK(roles_revision>=0 AND roles_revision<9007199254740991);

CREATE OR REPLACE FUNCTION public.roles_snapshot_writer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.roles_managed THEN RAISE EXCEPTION 'PDL_ROLES_MANAGED_DELETE_REQUIRES_RETENTION_REVIEW' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.roles_managed AND (NEW IS DISTINCT FROM OLD)
     AND current_setting('app.roles_snapshot_commit',true) IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'PDL_ROLES_LEGACY_WRITER_FENCED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS roles_snapshot_writer ON public.companies;
CREATE TRIGGER roles_snapshot_writer BEFORE UPDATE OR DELETE ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.roles_snapshot_writer_guard();

CREATE OR REPLACE FUNCTION public.roles_snapshot_deadline_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF OLD.roles_managed AND (NEW.data IS DISTINCT FROM OLD.data OR NEW.roles_revision IS DISTINCT FROM OLD.roles_revision) THEN
    IF NULLIF(current_setting('app.roles_snapshot_deadline',true),'') IS NULL
       OR clock_timestamp()>=current_setting('app.roles_snapshot_deadline',true)::timestamptz THEN
      RAISE EXCEPTION 'PDL_ROLES_DEADLINE' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS roles_snapshot_deadline ON public.companies;
CREATE CONSTRAINT TRIGGER roles_snapshot_deadline AFTER UPDATE ON public.companies
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.roles_snapshot_deadline_guard();

CREATE OR REPLACE FUNCTION public.commit_roles_snapshot(p_company_id uuid,p_expected_revision bigint,p_snapshot jsonb,p_deadline timestamptz)
RETURNS TABLE(revision bigint) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE current_revision bigint; enabled boolean;
BEGIN
  IF p_expected_revision IS NULL OR p_expected_revision<0 OR p_expected_revision>=9007199254740990
     OR p_deadline IS NULL OR p_deadline>clock_timestamp()+interval '10 minutes'
     OR p_snapshot->'company'->>'id' IS DISTINCT FROM p_company_id::text THEN
    RAISE EXCEPTION 'PDL_ROLES_INVALID_COMMIT' USING ERRCODE='22023';
  END IF;
  LOCK TABLE public.companies IN ROW EXCLUSIVE MODE;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.companies'::regclass AND tgname='roles_snapshot_writer'
    AND tgfoid='public.roles_snapshot_writer_guard()'::regprocedure AND tgenabled='O' AND tgtype=27 AND NOT tgisinternal
    AND tgqual IS NULL AND tgnargs=0 AND tgattr=''::int2vector) THEN
    RAISE EXCEPTION 'PDL_ROLES_WRITER_CONTRACT_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.companies'::regclass AND tgname='roles_snapshot_deadline'
    AND tgfoid='public.roles_snapshot_deadline_guard()'::regprocedure AND tgdeferrable AND tginitdeferred AND tgenabled='O'
    AND tgtype=17 AND tgqual IS NULL AND tgnargs=0 AND tgattr=''::int2vector AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'PDL_ROLES_DEADLINE_CONTRACT_REQUIRED' USING ERRCODE='23514';
  END IF;
  SELECT c.roles_revision,c.roles_managed INTO current_revision,enabled FROM public.companies c WHERE c.id=p_company_id FOR UPDATE;
  IF NOT FOUND OR NOT enabled THEN RAISE EXCEPTION 'PDL_ROLES_COMPANY_NOT_ENABLED' USING ERRCODE='23514'; END IF;
  IF current_revision<>p_expected_revision THEN RAISE EXCEPTION 'PDL_REVISION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF clock_timestamp()>=p_deadline THEN RAISE EXCEPTION 'PDL_ROLES_DEADLINE' USING ERRCODE='40001'; END IF;
  PERFORM set_config('app.roles_snapshot_commit',p_company_id::text,true);
  PERFORM set_config('app.roles_snapshot_deadline',p_deadline::text,true);
  UPDATE public.companies SET data=p_snapshot,name=p_snapshot->'company'->>'name',roles_revision=current_revision+1 WHERE id=p_company_id;
  RETURN QUERY SELECT current_revision+1;
END $$;
REVOKE ALL ON FUNCTION public.commit_roles_snapshot(uuid,bigint,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commit_roles_snapshot(uuid,bigint,jsonb,timestamptz) TO service_role;

-- The optional record transport must never become a second authority for a
-- managed snapshot. Ordinary companies keep its existing behavior.
CREATE OR REPLACE FUNCTION public.roles_snapshot_record_writer_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE target uuid;
BEGIN
  target:=CASE WHEN TG_OP='DELETE' THEN OLD.company_id ELSE NEW.company_id END;
  PERFORM 1 FROM public.companies WHERE id=target OR TG_OP='UPDATE' AND id=OLD.company_id ORDER BY id FOR SHARE;
  IF EXISTS(SELECT 1 FROM public.companies WHERE id=target AND roles_managed)
     OR TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.companies WHERE id=OLD.company_id AND roles_managed) THEN
    RAISE EXCEPTION 'PDL_ROLES_LEGACY_WRITER_FENCED' USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['tenant_records','tenant_revisions'] LOOP
    IF to_regclass('public.'||table_name) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS roles_snapshot_record_writer ON public.%I',table_name);
      EXECUTE format('CREATE TRIGGER roles_snapshot_record_writer BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.roles_snapshot_record_writer_guard()',table_name);
    END IF;
  END LOOP;
END $$;
COMMIT;
