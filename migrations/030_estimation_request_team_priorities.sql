BEGIN;

ALTER TABLE estimation_requests
  ADD COLUMN IF NOT EXISTS estimation_priority_order INTEGER,
  ADD COLUMN IF NOT EXISTS sales_priority_order INTEGER;

CREATE INDEX IF NOT EXISTS estimation_requests_estimation_priority_idx
  ON estimation_requests (assigned_engineer_id, estimation_priority_order);

CREATE INDEX IF NOT EXISTS estimation_requests_sales_priority_idx
  ON estimation_requests (sales_owner_id, sales_priority_order);

COMMIT;
