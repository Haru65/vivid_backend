const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CLEANUP_CONFIRMATION,
  buildCleanupPlan,
  parseArguments,
} = require('../scripts/cleanup-duplicate-customers');

test('customer cleanup defaults to dry-run and requires exact confirmation', () => {
  assert.deepEqual(parseArguments([]), { action: 'dry-run' });
  assert.throws(
    () => parseArguments(['--action=cleanup']),
    /Customer cleanup refused/,
  );
  assert.deepEqual(
    parseArguments(['--action=cleanup', `--confirm=${CLEANUP_CONFIRMATION}`]),
    { action: 'cleanup' },
  );
});

test('cleanup plan keeps one duplicate, chooses the most-linked canonical, and deletes unlinked unique customers', () => {
  const customers = [
    { id: 1, company_name: 'Acme Pvt. Ltd.', contact_person_email: 'old@example.com' },
    { id: 2, company_name: 'ACME PVT LTD' },
    { id: 3, company_name: 'Linked Unique' },
    { id: 4, company_name: 'Unlinked Unique' },
  ];
  const references = new Map([
    [1, [{ table: 'leads', count: 1 }]],
    [2, [{ table: 'leads', count: 3 }]],
    [3, [{ table: 'visit_tasks', count: 1 }]],
  ]);

  const plan = buildCleanupPlan(customers, references);
  assert.equal(plan.duplicateGroups.length, 1);
  assert.equal(plan.duplicateGroups[0].canonical.id, 2);
  assert.deepEqual(plan.duplicateGroups[0].duplicates.map((customer) => customer.id), [1]);
  assert.equal(plan.duplicateGroups[0].referencesToMove, 1);
  assert.deepEqual(plan.unlinkedUnique.map((customer) => customer.id), [4]);
  assert.deepEqual(plan.linkedUnique.map(({ customer }) => customer.id), [3]);
});

test('cleanup matching ignores punctuation, case, and repeated spaces', () => {
  const plan = buildCleanupPlan([
    { id: 10, company_name: 'Blue-Star  Limited' },
    { id: 11, company_name: 'blue star limited' },
  ], new Map());
  assert.equal(plan.duplicateGroups.length, 1);
  assert.equal(plan.duplicateGroups[0].duplicates.length, 1);
});
