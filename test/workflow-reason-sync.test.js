const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function mock(relativePath, exports) {
  const filename = path.resolve(__dirname, relativePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

function salesWorkflow({ leadStatus = 'Qualified', estimationStatus = 'in_progress' } = {}) {
  let lead = { id: 41, lead_status: leadStatus, sales_owner_id: 7, company_name: 'Shared workflow' };
  let estimation = { id: 52, lead_id: 41, status: estimationStatus };
  const db = {
    async query(sql, values = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (/SELECT \* FROM leads/.test(sql)) return { rows: [{ ...lead }] };
      if (/UPDATE leads SET status_before_hold = lead_status/.test(sql)) {
        lead = { ...lead, status_before_hold: lead.lead_status, lead_status: 'On Hold', hold_reason: values[1] };
        return { rows: [] };
      }
      if (/UPDATE leads SET lead_status = 'Dropped'/.test(sql)) {
        lead = { ...lead, lead_status: 'Dropped', drop_reason: values[1], hold_reason: null };
        return { rows: [] };
      }
      if (/UPDATE estimation_requests SET status_before_hold = status/.test(sql)) {
        estimation = { ...estimation, status_before_hold: estimation.status, status: 'on_hold', hold_reason: values[1] };
        return { rows: [] };
      }
      if (/UPDATE estimation_requests SET status = 'dropped'/.test(sql)) {
        estimation = { ...estimation, status: 'dropped', drop_reason: values[1], hold_reason: null };
        return { rows: [] };
      }
      if (/INSERT INTO lead_activities/.test(sql)) return { rows: [{}] };
      if (/FROM leads l/.test(sql)) return { rows: [{ ...lead }] };
      throw new Error(`Unexpected Sales workflow query: ${sql}`);
    },
    release() {},
  };
  mock('../config/db_connection.js', { connect: async () => db, query: db.query });
  mock('../controller/settings.js', { getMasterSettings: async () => ({}) });
  mock('../services/notificationService.js', {});
  const controllerPath = path.resolve(__dirname, '../controller/leads.js');
  delete require.cache[controllerPath];
  return {
    update: require(controllerPath).setLeadWorkflowState,
    state: () => ({ lead, estimation }),
  };
}

function estimationWorkflow({ estimationStatus = 'in_progress', leadStatus = 'Qualified' } = {}) {
  let request = {
    id: 52, lead_id: 41, status: estimationStatus, assigned_engineer_id: 8,
    lead_status: leadStatus, company_name: 'Shared workflow',
  };
  let lead = { id: 41, lead_status: leadStatus };
  const query = async (sql, values = []) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (/FROM estimation_requests er/.test(sql)) return { rows: [{ ...request, lead_status: lead.lead_status }] };
    if (/SELECT \* FROM estimation_requests/.test(sql)) return { rows: [{ ...request }] };
    if (/UPDATE estimation_requests SET status_before_hold = status/.test(sql)) {
      request = { ...request, status_before_hold: request.status, status: 'on_hold', hold_reason: values[1] };
      return { rows: [] };
    }
    if (/UPDATE estimation_requests SET status = 'dropped'/.test(sql)) {
      request = { ...request, status: 'dropped', drop_reason: values[1], hold_reason: null };
      return { rows: [] };
    }
    if (/UPDATE leads SET status_before_hold/.test(sql)) {
      lead = { ...lead, status_before_hold: lead.lead_status, lead_status: 'On Hold', hold_reason: values[1] };
      return { rows: [] };
    }
    if (/UPDATE leads SET lead_status = 'Dropped'/.test(sql)) {
      lead = { ...lead, lead_status: 'Dropped', drop_reason: values[1], hold_reason: null };
      return { rows: [] };
    }
    throw new Error(`Unexpected Estimation workflow query: ${sql}`);
  };
  mock('../config/db_connection.js', { query, connect: async () => ({ query, release() {} }) });
  mock('../controller/quotations.js', {});
  mock('../controller/leads.js', { logLeadActivity: async () => {} });
  mock('../services/notificationService.js', {});
  mock('../controller/settings.js', { getMasterSettings: async () => ({}) });
  const servicePath = path.resolve(__dirname, '../services/estimationService.js');
  delete require.cache[servicePath];
  return {
    update: require(servicePath).setEstimationWorkflowState,
    state: () => ({ lead, request }),
  };
}

const salesUser = { id: 7, role: 'sales_engineer', name: 'Sales Engineer' };
const estimationUser = { id: 8, role: 'estimation_engineer', name: 'Estimation Engineer' };

test('Sales hold reason is copied to the linked Estimation workflow', async () => {
  const app = salesWorkflow();
  await app.update(41, { action: 'hold', reason: 'Waiting for approved drawing' }, salesUser);
  assert.equal(app.state().lead.hold_reason, 'Waiting for approved drawing');
  assert.equal(app.state().estimation.hold_reason, 'Waiting for approved drawing');
  assert.equal(app.state().estimation.status, 'on_hold');
});

test('Sales drop reason is copied to the linked Estimation workflow', async () => {
  const app = salesWorkflow();
  await app.update(41, { action: 'drop', reason: 'Customer cancelled the enquiry' }, salesUser);
  assert.equal(app.state().lead.drop_reason, 'Customer cancelled the enquiry');
  assert.equal(app.state().estimation.drop_reason, 'Customer cancelled the enquiry');
  assert.equal(app.state().estimation.status, 'dropped');
});

test('Estimation hold reason is copied to the linked Sales workflow', async () => {
  const app = estimationWorkflow();
  await app.update(52, { action: 'hold', reason: 'Technical details are pending' }, estimationUser);
  assert.equal(app.state().request.hold_reason, 'Technical details are pending');
  assert.equal(app.state().lead.hold_reason, 'Technical details are pending');
  assert.equal(app.state().lead.lead_status, 'On Hold');
});

test('Estimation drop reason is copied to the linked Sales workflow', async () => {
  const app = estimationWorkflow();
  await app.update(52, { action: 'drop', reason: 'Product is outside the approved scope' }, estimationUser);
  assert.equal(app.state().request.drop_reason, 'Product is outside the approved scope');
  assert.equal(app.state().lead.drop_reason, 'Product is outside the approved scope');
  assert.equal(app.state().lead.lead_status, 'Dropped');
});
