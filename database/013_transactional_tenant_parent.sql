BEGIN;

-- A tenant repository revision is a child of public.companies. Older
-- replace_tenant_records deployments attempted to insert the child first,
-- which made every first write for a new signup fail its foreign key. This
-- trigger is a migration-safe guard for those already-deployed function
-- bodies as well as any future direct server-side repository writer.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.ensure_tenant_company_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  company_data jsonb;
  company_name text;
  company_has_name boolean;
BEGIN
  company_data := CASE
    WHEN jsonb_typeof(NEW.scalar_data->'company') = 'object' THEN NEW.scalar_data->'company'
    ELSE '{}'::jsonb
  END;
  company_has_name := NULLIF(btrim(company_data->>'name'), '') IS NOT NULL;
  company_name := left(COALESCE(NULLIF(btrim(company_data->>'name'), ''), 'Company'), 200);

  INSERT INTO public.companies(id, slug, name)
  VALUES(NEW.company_id, 'company-' || NEW.company_id::text, company_name)
  ON CONFLICT(id) DO UPDATE SET
    -- The first revision-zero row in older RPCs carries empty scalar data.
    -- Never replace a real company name with that temporary fallback. The
    -- following scalar-data update will synchronize the actual name.
    name = CASE
      WHEN company_has_name THEN EXCLUDED.name
      ELSE public.companies.name
    END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.ensure_tenant_company_parent()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS ensure_tenant_company_parent
  ON public.tenant_revisions;
CREATE TRIGGER ensure_tenant_company_parent
BEFORE INSERT OR UPDATE OF scalar_data
ON public.tenant_revisions
FOR EACH ROW
EXECUTE FUNCTION private.ensure_tenant_company_parent();

COMMIT;

-- Deployment verification: the trigger must exist and remain enabled.
SELECT
  trigger_name,
  event_manipulation,
  action_timing,
  action_statement
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND event_object_table = 'tenant_revisions'
  AND trigger_name = 'ensure_tenant_company_parent'
ORDER BY event_manipulation;
