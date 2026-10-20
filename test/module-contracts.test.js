const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const quotations = require('../controller/quotations');
const { hashPassword, USER_ROLES, verifyPassword } = require('../controller/userManagement');
const { validateAuthConfiguration } = require('../middleware/auth');
const { normalizePostalResponse, listDistrictsForState, listCitiesForDistrict } = require('../services/postalService');

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

test('presales is a supported hybrid sales and estimation role', () => {
  const estimationSource = fs.readFileSync(path.join(__dirname, '../services/estimationService.js'), 'utf8');
  const quotationSource = fs.readFileSync(path.join(__dirname, '../controller/quotations.js'), 'utf8');

  assert.equal(USER_ROLES.has('presales'), true);
  assert.match(estimationSource, /SALES_ROLES[^\n]*'presales'/);
  assert.match(estimationSource, /ESTIMATION_ROLES[^\n]*'presales'/);
  assert.match(estimationSource, /ESTIMATION_CONTRIBUTOR_ROLES[^\n]*'presales'/);
  assert.match(quotationSource, /PREPARATION_ROLES[^\n]*'presales'/);
  assert.match(quotationSource, /SALES_ROLES[^\n]*'presales'/);
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

test('quotation revisions update the existing quotation and preserve its number', () => {
  const quotationSource = fs.readFileSync(path.join(__dirname, '../controller/quotations.js'), 'utf8');
  const revisionFlow = quotationSource.slice(
    quotationSource.indexOf('async function createQuotationRevision'),
    quotationSource.indexOf('async function deleteQuotation'),
  );

  assert.match(revisionFlow, /UPDATE quotations/);
  assert.match(revisionFlow, /revision_number = \$1/);
  assert.match(revisionFlow, /WHERE id = \$5/);
  assert.doesNotMatch(revisionFlow, /INSERT INTO quotations/);
  assert.doesNotMatch(revisionFlow, /quotationNumber.*-R/);
});

test('uploaded PDFs receive quotation numbers instead of using their filenames', () => {
  const serviceSource = fs.readFileSync(path.join(__dirname, '../services/estimationService.js'), 'utf8');

  assert.match(serviceSource, /REGEXP_REPLACE\(COALESCE\(q\.quotation_number, equ\.quotation_number\).+AS quotation_number/);
  assert.match(serviceSource, /nextval\('quotation_number_seq'\)/);
  assert.match(serviceSource, /estimation_request_id, quotation_number, revision_number, filename/);
  assert.match(serviceSource, /\[uploaded\.quotation_number, request\.lead_id\]/);
  assert.doesNotMatch(serviceSource, /\[uploaded\.filename, request\.lead_id\]/);
  assert.doesNotMatch(serviceSource, /request\.uploaded_quote_filename/);
  assert.match(serviceSource, /REPLACE\(activity\.content, upload\.filename, upload\.quotation_number\)/);
});

test('postal lookup keeps district separate and returns selectable towns', () => {
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
    city: 'Vashi',
    district: 'Thane',
    post_offices: ['Vashi', 'Sanpada'],
  });
});

test('postal directory returns every Maharashtra district and all towns in a selected district', async () => {
  const state = await listDistrictsForState('Maharashtra');
  assert.equal(state.districts.length, 36);
  assert.ok(state.districts.includes('Pune'));
  assert.ok(state.districts.includes('Yavatmal'));

  const district = await listCitiesForDistrict('Maharashtra', 'Pune');
  assert.ok(district.cities.length > 700);
  assert.ok(district.cities.includes('Pune'));

  const unionTerritory = await listDistrictsForState('Dadra and Nagar Haveli and Daman and Diu');
  assert.ok(unionTerritory.districts.length > 0);
});
