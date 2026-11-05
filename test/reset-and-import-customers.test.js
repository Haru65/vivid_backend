const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DELETE_CONFIRMATION,
  mapUsersByName,
  normalizePhone,
  parseArguments,
  resolveAccountOwner,
  validateRows,
} = require('../scripts/reset-and-import-customers');

test('destructive reset actions require an exact confirmation phrase', () => {
  assert.throws(
    () => parseArguments(['--action=reset-and-import', '--file=/tmp/customers.xlsx']),
    /Destructive action refused/,
  );
  assert.deepEqual(
    parseArguments([
      '--action=reset-and-import',
      '--file=/tmp/customers.xlsx',
      `--confirm=${DELETE_CONFIRMATION}`,
    ]),
    { action: 'reset-and-import', file: '/tmp/customers.xlsx' },
  );
});

test('long phone fields prefer a usable Indian mobile number', () => {
  assert.equal(normalizePhone('022-40166714 / 022-40160807 / 9821316778'), '9821316778');
  assert.equal(normalizePhone('022 4005 4673'), '022 4005 4673');
  assert.equal(normalizePhone(''), null);
});

test('account owners match an exact full name or a unique first name', () => {
  const index = mapUsersByName([
    { id: 8, first_name: 'Rajesh', last_name: 'Bairagi', is_active: true },
    { id: 9, first_name: 'Rakesh', last_name: 'Sharma', is_active: true },
  ]);
  assert.deepEqual(resolveAccountOwner('Rajesh', index), {
    id: 8,
    name: 'Rajesh Bairagi',
    matched: true,
  });
  assert.deepEqual(resolveAccountOwner('Rakesh Sharma', index), {
    id: 9,
    name: 'Rakesh Sharma',
    matched: true,
  });
  assert.deepEqual(resolveAccountOwner('Unknown Person', index), {
    id: null,
    name: 'Unknown Person',
    matched: false,
  });
});

test('workbook validation rejects missing company names but only warns for legacy optional data', () => {
  const result = validateRows([
    { rowNumber: 2, customer: { company_name: null } },
    { rowNumber: 3, customer: { company_name: 'Acme', contact_person_name: null, contact_person_email: null, billing_address: null } },
  ]);
  assert.deepEqual(result.errors, ['Row 2: company name is required.']);
  assert.equal(result.warnings.length, 6);
});
