-- Lead edits submitted by Sales Engineers now route directly to Estimation Head.
-- Sales Head columns remain nullable for historical audit records.
ALTER TABLE lead_change_requests
  ALTER COLUMN sales_head_id DROP NOT NULL;
