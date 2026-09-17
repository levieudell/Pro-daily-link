BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('tenant-backups', 'tenant-backups', false, 25000000, ARRAY['application/json'])
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- No browser policies are intentionally created. Only the server-side service
-- credential can create or read a backup. Every key begins with the company ID.

COMMIT;

