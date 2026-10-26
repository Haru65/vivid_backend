BEGIN;

ALTER TABLE lead_followups
  ADD COLUMN IF NOT EXISTS completion_latitude NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS completion_longitude NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS completion_accuracy_m NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS location_captured_at TIMESTAMPTZ;

COMMIT;
