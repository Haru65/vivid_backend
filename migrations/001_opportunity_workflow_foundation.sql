BEGIN;

CREATE SEQUENCE IF NOT EXISTS enquiry_number_seq;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS contact_person_email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS billing_address TEXT,
  ADD COLUMN IF NOT EXISTS shipping_address TEXT,
  ADD COLUMN IF NOT EXISTS state VARCHAR(100);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS enquiry_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS sales_owner_id BIGINT,
  ADD COLUMN IF NOT EXISTS current_stage VARCHAR(50) NOT NULL DEFAULT 'enquiry',
  ADD COLUMN IF NOT EXISTS current_assignee_id BIGINT,
  ADD COLUMN IF NOT EXISTS current_department VARCHAR(100) NOT NULL DEFAULT 'Sales',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE leads
SET enquiry_number = 'ENQ-' || TO_CHAR(COALESCE(enquiry_date, created_at::date, CURRENT_DATE), 'YYYY') || '-' || LPAD(id::text, 5, '0')
WHERE enquiry_number IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS leads_enquiry_number_idx ON leads (enquiry_number);
CREATE INDEX IF NOT EXISTS leads_customer_id_idx ON leads (customer_id);
CREATE INDEX IF NOT EXISTS leads_current_work_idx ON leads (current_assignee_id, current_stage, updated_at DESC);

ALTER TABLE lead_activities ADD COLUMN IF NOT EXISTS actor_user_id BIGINT;

ALTER TABLE estimation_requests
  ADD COLUMN IF NOT EXISTS current_stage VARCHAR(50) NOT NULL DEFAULT 'estimation_submitted',
  ADD COLUMN IF NOT EXISTS current_assignee_id BIGINT;

ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS boq_data JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS costing_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS total_internal_cost NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS selling_price NUMERIC(14, 2),
  ADD COLUMN IF NOT EXISTS margin_percent NUMERIC(7, 2),
  ADD COLUMN IF NOT EXISTS revision_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS customer_request TEXT,
  ADD COLUMN IF NOT EXISTS sales_notes TEXT;

ALTER TABLE po_closure_sheets
  ADD COLUMN IF NOT EXISTS changes_requested_by_user_id BIGINT,
  ADD COLUMN IF NOT EXISTS changes_requested_by_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS changes_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS changes_requested_reason TEXT,
  ADD COLUMN IF NOT EXISTS ready_for_erp_at TIMESTAMPTZ;

ALTER TABLE po_closure_sheets DROP CONSTRAINT IF EXISTS po_closure_sheets_status_check;
ALTER TABLE po_closure_sheets ADD CONSTRAINT po_closure_sheets_status_check
  CHECK (status IN ('sales_draft', 'submitted_to_estimation', 'estimation_in_progress', 'submitted_to_head', 'changes_requested', 'approved_by_estimation_head', 'ready_for_erp'));

COMMIT;
