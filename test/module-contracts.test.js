const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const quotations = require('../controller/quotations');
const tasks = require('../controller/tasks');
const { normalizeMasterSettings } = require('../controller/settings');
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

test('visit tasks expose persistent CRUD operations and an authenticated route', () => {
  for (const operation of ['retrieveTasks', 'createTask', 'updateTask', 'updateTaskStatus', 'updateTaskReview', 'rescheduleTask', 'deleteTask']) {
    assert.equal(typeof tasks[operation], 'function', `${operation} must be exported`);
  }

  const serverSource = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const routeSource = fs.readFileSync(path.join(__dirname, '../routes/tasks.js'), 'utf8');
  const schemaSource = fs.readFileSync(path.join(__dirname, '../config/db_schema.js'), 'utf8');
  const controllerSource = fs.readFileSync(path.join(__dirname, '../controller/tasks.js'), 'utf8');

  assert.match(serverSource, /app\.use\('\/tasks', taskRouter\)/);
  assert.match(routeSource, /requireRoles\('admin', 'sales_head', 'sales_engineer', 'salesperson', 'presales'\)/);
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS visit_tasks/);
  assert.match(controllerSource, /Meeting date and time must be in the future/);
  assert.match(controllerSource, /FROM customers/);
  assert.match(controllerSource, /updateTaskReview/);
  assert.match(controllerSource, /COALESCE\(assigned_to_user_id, created_by_user_id\) = \$2/);
  assert.match(controllerSource, /canonicalAssignee/);
  assert.match(controllerSource, /New visit task assigned/);
  assert.match(controllerSource, /sort_order/);
  assert.match(controllerSource, /priority/);
  assert.match(controllerSource, /all_day/);
  assert.match(controllerSource, /next_activity/);
  assert.match(controllerSource, /Only the assigned Sales Engineer or a Sales Manager can reschedule/);
  assert.match(controllerSource, /A cancelled task cannot be rescheduled/);
  assert.match(controllerSource, /TASK_MANAGER_ROLES/);
  assert.match(routeSource, /\/:id\/reschedule/);
});

test('dashboard master settings keep supported role widgets and reject unknown values', () => {
  const settings = normalizeMasterSettings({
    dashboard_widgets: {
      admin: ['executive_metrics', 'sales_funnel', 'unknown_widget', 'sales_funnel'],
      sales_head: [],
    },
  });

  assert.deepEqual(settings.dashboard_widgets.admin, ['executive_metrics', 'sales_funnel']);
  assert.deepEqual(settings.dashboard_widgets.sales_head, []);
  assert.ok(settings.dashboard_widgets.erp.includes('project_health'));
  assert.equal(Object.hasOwn(settings.dashboard_widgets, 'unknown_role'), false);
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

test('Estimation Manager has all-enquiry visibility and allotment without Head approval', () => {
  const estimationSource = fs.readFileSync(path.join(__dirname, '../services/estimationService.js'), 'utf8');
  const leadRouteSource = fs.readFileSync(path.join(__dirname, '../routes/lead_dashboard.js'), 'utf8');
  const managerWidgets = normalizeMasterSettings({}).dashboard_widgets.estimation_manager;

  assert.equal(USER_ROLES.has('estimation_manager'), true);
  assert.deepEqual(managerWidgets, ['engineer_performance']);
  assert.match(estimationSource, /\['admin', 'estimation_head', 'estimation_manager', 'sales_head'\]\.includes\(user\?\.role\)/);
  assert.match(estimationSource, /user\?\.role === 'presales'.+revision_requested_by_sales/);
  assert.match(estimationSource, /requireEstimationAllocator\(user\)/);
  assert.match(estimationSource, /\['admin', 'estimation_head', 'estimation_manager'\]\.includes\(user\?\.role\)/);
  assert.match(estimationSource, /function isEstimationHead\(user\) \{\s+return \['admin', 'estimation_head'\]\.includes\(user\?\.role\);\s+\}/);
  assert.match(leadRouteSource, /router\.use\(requireRoles\(\.\.\.SALES_ROLES, 'estimation_manager'\)\)/);
  assert.match(leadRouteSource, /router\.post\('\/create-lead', requireSalesRole/);
  assert.match(leadRouteSource, /router\.put\('\/update-lead\/:id', requireSalesRole/);
  assert.match(leadRouteSource, /router\.delete\('\/delete-lead\/:id', requireSalesRole/);
});

test('lead enquiry note updates stay synchronized with estimation', () => {
  const leadSource = fs.readFileSync(path.join(__dirname, '../controller/leads.js'), 'utf8');
  const estimationSource = fs.readFileSync(path.join(__dirname, '../services/estimationService.js'), 'utf8');

  assert.match(
    leadSource,
    /SET enquiry_notes = \$1,[\s\S]*WHERE lead_id = \$2[\s\S]*enquiry_notes IS DISTINCT FROM \$1/,
  );
  assert.match(estimationSource, /l\.enquiry_notes AS enquiry_notes/);
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
  const reviewFlow = serviceSource.slice(
    serviceSource.indexOf('async function reviewSalesRevision'),
    serviceSource.indexOf('async function markClientApproved'),
  );

  assert.match(salesRevisionFlow, /status = 'revision_requested_by_sales'/);
  assert.match(salesRevisionFlow, /revision_notes = \$1/);
  assert.doesNotMatch(salesRevisionFlow, /createQuotationRevision\(/);
  assert.match(reviewFlow, /status = 'revision_requested'/);
  assert.match(reviewFlow, /assigned_engineer_id = \$2/);
  assert.match(reviewFlow, /status = 'sent_to_client'/);
  assert.match(estimationSaveFlow, /request\.revision_requested_by === 'sales'/);
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

test('uploaded PDFs require Estimation quotation numbers instead of automatic numbers or filenames', () => {
  const serviceSource = fs.readFileSync(path.join(__dirname, '../services/estimationService.js'), 'utf8');
  const uploadFlow = serviceSource.slice(
    serviceSource.indexOf('async function uploadRequestQuotationPdf'),
    serviceSource.indexOf('async function getUploadedRequestQuotationPdf'),
  );

  assert.match(serviceSource, /COALESCE\(REGEXP_REPLACE\(q\.quotation_number.+equ\.quotation_number\) AS quotation_number/);
  assert.match(uploadFlow, /uploadedQuotationNumber\(metadata\.quotation_number\)/);
  assert.doesNotMatch(uploadFlow, /nextUploadedQuotationNumber/);
  assert.match(uploadFlow, /estimation_request_id, quotation_number, revision_number, filename/);
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
