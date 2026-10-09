BEGIN;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS enquiry_state VARCHAR(20) NOT NULL DEFAULT 'Purchase';

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_enquiry_state_check;
ALTER TABLE leads ADD CONSTRAINT leads_enquiry_state_check
  CHECK (enquiry_state IN ('Purchase', 'Tender', 'Budget'));

COMMIT;
