const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const quotations = require('../controller/quotations');
const { hashPassword, verifyPassword } = require('../controller/userManagement');
const { validateAuthConfiguration } = require('../middleware/auth');
const { normalizePostalResponse } = require('../services/postalService');

test('quotation controller exposes every routed operation', () => {
  for (const operation of [
    'retrieveQuotations',
    'createQuotation',
    'createQuotationRevision',
    'updateQuotation',
    'deleteQuotation',
    'sendQuotation',
    'generateQuotationDocument',
  ]) {
    assert.equal(typeof quotations[operation], 'function', `${operation} must be exported`);
  }
});

test('password hashing accepts valid passwords and rejects invalid credentials', () => {
  const hash = hashPassword('safe-pass-123');
  assert.equal(verifyPassword('safe-pass-123', hash), true);
  assert.equal(verifyPassword('wrong-pass-123', hash), false);
  assert.throws(() => hashPassword('short'), /at least 8 characters/);
});

test('production authentication requires an explicit JWT secret', () => {
  const previousEnvironment = process.env.NODE_ENV;
  const previousSecret = process.env.JWT_SECRET;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    assert.throws(() => validateAuthConfiguration(), /JWT_SECRET/);
    process.env.JWT_SECRET = 'test-production-secret';
    assert.doesNotThrow(() => validateAuthConfiguration());
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

test('sales forwards revision notes while estimation creates the revision quotation', () => {
  const serviceSource = fs.readFileSync(path.join(__dirname, '../services/estimationService.js'), 'utf8');
  const salesRevisionFlow = serviceSource.slice(
    serviceSource.indexOf('async function requestSalesRevision'),
    serviceSource.indexOf('async function markClientApproved'),
  );
  const estimationSaveFlow = serviceSource.slice(
    serviceSource.indexOf('async function createOrUpdateRequestQuotation'),
    serviceSource.indexOf('async function submitForReview'),
  );

  assert.match(salesRevisionFlow, /status = 'revision_requested_by_sales'/);
  assert.match(salesRevisionFlow, /revision_notes = \$1/);
  assert.doesNotMatch(salesRevisionFlow, /createQuotationRevision\(/);
  assert.match(estimationSaveFlow, /request\.status === 'revision_requested_by_sales'/);
  assert.match(estimationSaveFlow, /createQuotationRevision\(request\.quotation_id/);
});

test('uploaded PDFs receive quotation numbers instead of using their filenames', () => {
  const serviceSource = fs.readFileSync(path.join(__dirname, '../services/estimationService.js'), 'utf8');

  assert.match(serviceSource, /COALESCE\(q\.quotation_number, equ\.quotation_number\) AS quotation_number/);
  assert.match(serviceSource, /nextval\('quotation_number_seq'\)/);
  assert.match(serviceSource, /estimation_request_id, quotation_number, revision_number, filename/);
  assert.match(serviceSource, /\[uploaded\.quotation_number, request\.lead_id\]/);
  assert.doesNotMatch(serviceSource, /\[uploaded\.filename, request\.lead_id\]/);
});

test('postal lookup maps district and state into lead location fields', () => {
  const location = normalizePostalResponse({
    success: true,
    data: {
      post_offices: [
        { office_name: 'Vashi', district: 'Thane', state: 'Maharashtra' },
        { office_name: 'Sanpada', district: 'Thane', state: 'Maharashtra' },
      ],
    },
  }, '400703');

  assert.deepEqual(location, {
    pincode: '400703',
    state: 'Maharashtra',
    city: 'Thane',
    district: 'Thane',
    post_offices: ['Vashi', 'Sanpada'],
  });
});
