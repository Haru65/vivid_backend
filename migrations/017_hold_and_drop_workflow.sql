ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS hold_reason TEXT,
  ADD COLUMN IF NOT EXISTS drop_reason TEXT,
  ADD COLUMN IF NOT EXISTS status_before_hold VARCHAR(50),
  ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dropped_at TIMESTAMPTZ;

ALTER TABLE estimation_requests
  ADD COLUMN IF NOT EXISTS hold_reason TEXT,
  ADD COLUMN IF NOT EXISTS drop_reason TEXT,
  ADD COLUMN IF NOT EXISTS status_before_hold VARCHAR(50),
  ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dropped_at TIMESTAMPTZ;

ALTER TABLE estimation_requests DROP CONSTRAINT IF EXISTS estimation_requests_status_check;
ALTER TABLE estimation_requests ADD CONSTRAINT estimation_requests_status_check
  CHECK (status IN ('submitted', 'assigned', 'in_progress', 'submitted_for_review', 'revision_requested', 'revision_requested_by_sales', 'revision_in_progress', 'revision_submitted_for_review', 'approved', 'returned_to_sales', 'sent_to_client', 'client_approved', 'discarded', 'on_hold', 'dropped', 'po_sales_draft', 'po_submitted_to_estimation', 'po_estimation_in_progress', 'po_submitted_to_head', 'po_approved_by_estimation_head', 'cancelled'));

DROP INDEX IF EXISTS estimation_requests_open_lead_idx;
CREATE UNIQUE INDEX estimation_requests_open_lead_idx
  ON estimation_requests (lead_id)
  WHERE status NOT IN ('cancelled', 'discarded', 'dropped', 'sent_to_client');
