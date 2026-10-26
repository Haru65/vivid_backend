BEGIN;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS pan VARCHAR(10),
  ADD COLUMN IF NOT EXISTS designation VARCHAR(255),
  ADD COLUMN IF NOT EXISTS alternate_contact_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS alternate_contact_phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS alternate_contact_email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS account_owner_user_id BIGINT,
  ADD COLUMN IF NOT EXISTS account_owner_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS remarks TEXT;

CREATE INDEX IF NOT EXISTS customers_account_owner_idx
  ON customers (account_owner_user_id, updated_at DESC);

COMMIT;
