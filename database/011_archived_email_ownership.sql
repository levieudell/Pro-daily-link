BEGIN;

-- 009/010 may already be installed in production. Remove stale ownership from
-- archived tenants, then enforce the invariant for every future write even if
-- an older replace_tenant_records function is still cached during rollout.
LOCK TABLE private.tenant_directory, private.tenant_active_user_emails
  IN SHARE ROW EXCLUSIVE MODE;

DELETE FROM private.tenant_active_user_emails AS email
USING private.tenant_directory AS directory
WHERE directory.company_id = email.company_id
  AND lower(COALESCE(directory.company_data->>'archivedDuplicate', 'false')) = 'true';

CREATE OR REPLACE FUNCTION private.keep_archived_tenant_email_unowned()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM private.tenant_directory AS directory
    WHERE directory.company_id = NEW.company_id
      AND lower(COALESCE(directory.company_data->>'archivedDuplicate', 'false')) = 'true'
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.keep_archived_tenant_email_unowned()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS keep_archived_tenant_email_unowned
  ON private.tenant_active_user_emails;
CREATE TRIGGER keep_archived_tenant_email_unowned
BEFORE INSERT OR UPDATE ON private.tenant_active_user_emails
FOR EACH ROW EXECUTE FUNCTION private.keep_archived_tenant_email_unowned();

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Deployment evidence: this must return zero rows.
SELECT email.normalized_email, email.company_id
FROM private.tenant_active_user_emails AS email
JOIN private.tenant_directory AS directory ON directory.company_id = email.company_id
WHERE lower(COALESCE(directory.company_data->>'archivedDuplicate', 'false')) = 'true';
