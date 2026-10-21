BEGIN;

-- Fail instead of waiting behind an unexpected production lock or holding a
-- table lock indefinitely. Production tables are currently tiny, so a normal
-- index build should finish in seconds during the verified write fence.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- PostgreSQL does not create indexes on referencing columns automatically.
-- These indexes cover every foreign key reported by Supabase's
-- unindexed_foreign_keys advisor on 2026-10-20. They are deliberately plain
-- B-tree indexes: every key is an equality/join key and all tables are small
-- enough for this forward-only migration to run inside the normal migration
-- transaction.
CREATE INDEX IF NOT EXISTS assignments_project_id_idx
  ON public.assignments (project_id);

CREATE INDEX IF NOT EXISTS audit_events_actor_user_id_idx
  ON public.audit_events (actor_user_id);
CREATE INDEX IF NOT EXISTS audit_events_company_id_idx
  ON public.audit_events (company_id);

CREATE INDEX IF NOT EXISTS changes_project_id_idx
  ON public.changes (project_id);
CREATE INDEX IF NOT EXISTS changes_report_id_idx
  ON public.changes (report_id);

CREATE INDEX IF NOT EXISTS guest_links_project_id_idx
  ON public.guest_links (project_id);
CREATE INDEX IF NOT EXISTS guest_links_subcontractor_id_idx
  ON public.guest_links (subcontractor_id);

CREATE INDEX IF NOT EXISTS memberships_user_id_idx
  ON public.memberships (user_id);

CREATE INDEX IF NOT EXISTS photos_project_id_idx
  ON public.photos (project_id);
CREATE INDEX IF NOT EXISTS photos_report_id_idx
  ON public.photos (report_id);

CREATE INDEX IF NOT EXISTS projects_customer_id_idx
  ON public.projects (customer_id);

CREATE INDEX IF NOT EXISTS reports_project_id_idx
  ON public.reports (project_id);
CREATE INDEX IF NOT EXISTS reports_subcontractor_id_idx
  ON public.reports (subcontractor_id);
CREATE INDEX IF NOT EXISTS reports_submitted_by_idx
  ON public.reports (submitted_by);

CREATE INDEX IF NOT EXISTS subcontractors_company_id_idx
  ON public.subcontractors (company_id);
CREATE INDEX IF NOT EXISTS team_members_company_id_idx
  ON public.team_members (company_id);

CREATE INDEX IF NOT EXISTS workdays_project_id_idx
  ON public.workdays (project_id);

COMMIT;

-- Deployment evidence: this must return zero rows. An index covers a foreign
-- key when its leading columns match the foreign-key columns in order. Ignore
-- invalid or not-yet-ready indexes so an interrupted build cannot pass.
WITH foreign_keys AS (
  SELECT
    constraint_row.oid AS constraint_oid,
    constraint_row.conrelid AS table_oid,
    constraint_row.conname AS constraint_name,
    constraint_row.conkey AS key_columns
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = constraint_row.conrelid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = table_row.relnamespace
  WHERE constraint_row.contype = 'f'
    AND namespace_row.nspname = 'public'
), uncovered AS (
  SELECT foreign_key.*
  FROM foreign_keys AS foreign_key
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = foreign_key.table_oid
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts >= cardinality(foreign_key.key_columns)
      AND (index_row.indkey::smallint[])[0:cardinality(foreign_key.key_columns) - 1]
          = foreign_key.key_columns
  )
)
SELECT
  table_oid::regclass::text AS table_name,
  constraint_name
FROM uncovered
ORDER BY table_name, constraint_name;
