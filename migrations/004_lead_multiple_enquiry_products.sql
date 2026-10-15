BEGIN;

ALTER TABLE leads
  ALTER COLUMN enquiry_product TYPE TEXT;

ALTER TABLE estimation_requests
  ALTER COLUMN enquiry_product TYPE TEXT;

COMMIT;
