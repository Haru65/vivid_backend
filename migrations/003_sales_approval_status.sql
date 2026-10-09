BEGIN;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS sales_approval_status VARCHAR(30) NOT NULL DEFAULT 'Not Vivid Approved';

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_sales_approval_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_sales_approval_status_check
  CHECK (sales_approval_status IN ('Vivid Approved', 'ABB Approval', 'Not Vivid Approved'));

COMMIT;
