const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function mock(relativePath, exports) {
  const filename = path.resolve(__dirname, relativePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

function setup() {
  const statements = [];
  const query = async (sql, values = []) => {
    statements.push({ sql, values });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (/SELECT id, first_name, last_name/.test(sql)) {
      return { rows: [{ id: 19, first_name: 'Sales', last_name: 'Engineer' }] };
    }
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [] };
    if (/SELECT id, company_name/.test(sql)) return { rows: [] };
    if (/INSERT INTO customers/.test(sql)) return { rows: [{ id: 51, company_name: values[0] }] };
    throw new Error(`Unexpected quick customer query: ${sql}`);
  };
  mock('../config/db_connection.js', { query, connect: async () => ({ query, release() {} }) });
  mock('../controller/leads.js', { logLeadActivity: async () => null });
  const controllerPath = path.resolve(__dirname, '../controller/customers.js');
  delete require.cache[controllerPath];
  return { controller: require(controllerPath), statements };
}

const fullCustomer = {
  company_name: 'New Lead Customer',
  contact_person_name: 'Primary Contact',
  contact_person_email: 'contact@example.com',
  contact_person_phone: '9876543210',
  billing_address: 'Plot 12, Industrial Estate',
  country: 'India',
  state: 'Maharashtra',
  district: 'Pune',
  city: 'Pune',
  pincode: '411001',
  segment: 'Industry',
  region: 'Pune',
  remarks: 'Created while adding a lead',
  account_owner_user_id: 19,
};

test('lead-workflow customer creation saves the complete current customer form and selected owner', async () => {
  const app = setup();
  await app.controller.quickCreateCustomer(fullCustomer, { id: 3, name: 'Sales Head', role: 'sales_head' });
  const insert = app.statements.find(({ sql }) => /INSERT INTO customers/.test(sql));
  assert.ok(insert);
  assert.equal(insert.values[2], 'Pune');
  assert.equal(insert.values[6], 'Industry');
  assert.equal(insert.values[12], 'Plot 12, Industrial Estate');
  assert.equal(insert.values[14], 'Maharashtra');
  assert.equal(insert.values[23], 'Pune');
  assert.equal(insert.values[24], '411001');
  assert.equal(insert.values[31], 'Created while adding a lead');
  assert.equal(insert.values[32], 'Pune');
  assert.equal(insert.values[35], 19);
  assert.equal(insert.values[36], 'Sales Engineer');
});

test('a Sales Engineer creating a customer from a lead is assigned as its owner', async () => {
  const app = setup();
  await app.controller.quickCreateCustomer(
    { ...fullCustomer, account_owner_user_id: null },
    { id: 27, name: 'Current Sales Engineer', role: 'sales_engineer' },
  );
  const insert = app.statements.find(({ sql }) => /INSERT INTO customers/.test(sql));
  assert.equal(insert.values[35], 27);
  assert.equal(insert.values[36], 'Current Sales Engineer');
});
