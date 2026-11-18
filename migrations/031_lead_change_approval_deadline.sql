ALTER TABLE lead_change_requests
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP + INTERVAL '3 days'),
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_approved_at TIMESTAMPTZ;

UPDATE lead_change_requests
SET due_at = created_at + INTERVAL '3 days'
WHERE due_at IS NULL;

ALTER TABLE lead_change_requests ALTER COLUMN due_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS lead_change_requests_deadline_idx
  ON lead_change_requests (status, due_at)
  WHERE status = 'pending';
