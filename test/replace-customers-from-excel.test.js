const assert = require('node:assert/strict');
const test = require('node:test');

const {
  REPLACE_CONFIRMATION,
  SYNC_CONFIRMATION,
  buildSyncPlan,
  parseArguments,
} = require('../scripts/replace-customers-from-excel');

test('customer replacement requires an Excel file', () => {
  assert.throws(
    () => parseArguments(['--action=dry-run']),
    /--file is required/,
  );
});

test('customer replacement requires its exact confirmation phrase', () => {
  assert.throws(
    () => parseArguments(['--action=replace', '--file=/tmp/customers.xlsx']),
    /Customer replacement refused/,
  );
  assert.deepEqual(
    parseArguments([
      '--action=replace',
      '--file=/tmp/customers.xlsx',
      `--confirm=${REPLACE_CONFIRMATION}`,
    ]),
    { action: 'replace', file: '/tmp/customers.xlsx' },
  );
});

test('dry-run is the safe default action', () => {
  assert.deepEqual(
    parseArguments(['--file=/tmp/customers.xlsx']),
    { action: 'dry-run', file: '/tmp/customers.xlsx' },
  );
});

test('customer synchronization requires its exact confirmation phrase', () => {
  assert.throws(
    () => parseArguments(['--action=sync', '--file=/tmp/customers.xlsx']),
    /Customer synchronization refused/,
  );
  assert.deepEqual(
    parseArguments([
      '--action=sync',
      '--file=/tmp/customers.xlsx',
      `--confirm=${SYNC_CONFIRMATION}`,
    ]),
    { action: 'sync', file: '/tmp/customers.xlsx' },
  );
});

test('sync plan preserves IDs, retains linked old customers, and deletes only unlinked old customers', () => {
  const workbookRows = [
    { rowNumber: 2, customer: { company_name: 'Acme Pvt. Ltd.' } },
    { rowNumber: 3, customer: { company_name: 'New Company' } },
  ];
  const existingCustomers = [
    { id: 10, company_name: 'ACME PVT LTD' },
    { id: 11, company_name: 'Linked Legacy' },
    { id: 12, company_name: 'Unlinked Legacy' },
  ];
  const references = new Map([[11, [{ table: 'leads', count: 2 }]]]);

  const plan = buildSyncPlan(workbookRows, existingCustomers, references);
  assert.deepEqual(plan.updates.map((item) => item.existing.id), [10]);
  assert.deepEqual(plan.inserts.map((item) => item.customer.company_name), ['New Company']);
  assert.deepEqual(plan.deletions.map((item) => item.id), [12]);
  assert.deepEqual(plan.retainedLinked.map((item) => item.id), [11]);
  assert.deepEqual(plan.conflicts, []);
});

test('sync plan reports duplicate Excel company names instead of guessing', () => {
  const plan = buildSyncPlan([
    { rowNumber: 2, customer: { company_name: 'Acme' } },
    { rowNumber: 8, customer: { company_name: 'ACME' } },
  ], [], new Map());
  assert.deepEqual(plan.conflicts, [{
    company: 'Acme',
    reason: 'duplicate_excel_rows',
    excelRows: [2, 8],
  }]);
});
