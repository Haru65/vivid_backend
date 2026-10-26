BEGIN;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_sales_approval_status_check;

UPDATE leads
SET sales_approval_status = CASE
  WHEN sales_approval_status = 'ABB Approval' THEN 'OEM'
  WHEN sales_approval_status = 'Not Vivid Approved' THEN 'Vivid Not Approved'
  ELSE sales_approval_status
END;

ALTER TABLE leads
  ALTER COLUMN sales_approval_status SET DEFAULT 'Vivid Not Approved';

ALTER TABLE leads ADD CONSTRAINT leads_sales_approval_status_check
  CHECK (sales_approval_status IN ('Vivid Approved', 'Vivid Not Approved', 'OEM'));

COMMIT;
