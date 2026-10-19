ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN (
    'admin',
    'salesperson',
    'sales_head',
    'sales_engineer',
    'presales',
    'estimation_head',
    'estimation_engineer',
    'erp'
  ));
