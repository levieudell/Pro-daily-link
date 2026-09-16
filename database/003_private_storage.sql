BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('project-photos', 'project-photos', false, 6291456, ARRAY['image/jpeg','image/png','image/webp']),
  ('estimate-documents', 'estimate-documents', false, 15728640, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- No public client policies are created. The application server will validate
-- tenant/project access and use a server-only service credential to issue
-- short-lived signed URLs. Object keys must begin with the company UUID.

COMMIT;
