BEGIN;

-- These tables live in Supabase's exposed public schema but are accessed only
-- by the Pro Daily Link backend with its server-side secret key. Browser roles
-- must not be able to read or mutate company snapshots or internal user rows.
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.companies FROM anon, authenticated;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.users FROM anon, authenticated;

COMMIT;

-- Verification query: both rows should report rowsecurity=true and
-- forcerowsecurity=true after this migration finishes.
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE oid IN ('public.companies'::regclass, 'public.users'::regclass)
ORDER BY relname;
