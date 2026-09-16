-- Durable application state for the connected MVP.
-- The normalized tenant tables remain the long-term source model; this snapshot
-- makes every workflow durable while that repository cutover is completed.
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS data jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS companies_data_updated_idx
  ON public.companies ((data->'company'->>'createdAt'));
