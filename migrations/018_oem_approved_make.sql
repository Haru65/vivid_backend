BEGIN;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_sales_approval_status_check;

UPDATE leads
SET sales_approval_status = 'OEM Approved'
WHERE sales_approval_status IN ('OEM', 'ABB Approval');

ALTER TABLE leads ADD CONSTRAINT leads_sales_approval_status_check
  CHECK (sales_approval_status IN ('Vivid Approved', 'Vivid Not Approved', 'OEM Approved'));

COMMIT;
