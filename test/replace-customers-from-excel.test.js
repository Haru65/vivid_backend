const assert = require('node:assert/strict');
const test = require('node:test');

const {
  REPLACE_CONFIRMATION,
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
