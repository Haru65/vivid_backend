ALTER TABLE po_closure_sheets
  ADD COLUMN IF NOT EXISTS approval_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS approval_requested_by_user_id BIGINT,
  ADD COLUMN IF NOT EXISTS approval_requested_by_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS approval_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS md_approval_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS md_decided_by_user_id BIGINT,
  ADD COLUMN IF NOT EXISTS md_decided_by_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS md_decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS md_decision_comments TEXT,
  ADD COLUMN IF NOT EXISTS order_finalized_by_user_id BIGINT,
  ADD COLUMN IF NOT EXISTS order_finalized_by_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS order_finalized_at TIMESTAMPTZ;
