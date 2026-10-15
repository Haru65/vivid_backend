-- Must be run by the leads table owner (currently postgres in the local database).
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS loss_reason VARCHAR(255),
  ADD COLUMN IF NOT EXISTS sales_owner_id BIGINT,
  ADD COLUMN IF NOT EXISTS current_stage VARCHAR(50) NOT NULL DEFAULT 'enquiry',
  ADD COLUMN IF NOT EXISTS current_assignee_id BIGINT,
  ADD COLUMN IF NOT EXISTS current_department VARCHAR(100) NOT NULL DEFAULT 'Sales',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS leads_current_work_idx
ON leads (current_assignee_id, current_stage, updated_at DESC);
