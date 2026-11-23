const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function workflow(initialLead, { failActivity = false } = {}) {
  let stored = initialLead && { ...initialLead };
  let pending;
  const calls = [];
  const activities = [];
  const db = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql === 'BEGIN') { pending = stored && { ...stored }; return { rows: [] }; }
      if (sql === 'COMMIT') { stored = pending; return { rows: [] }; }
      if (sql === 'ROLLBACK') { pending = undefined; return { rows: [] }; }
      if (/SELECT \* FROM leads/.test(sql)) return { rows: pending ? [pending] : [] };
      if (/UPDATE leads SET lead_status = 'Lost'/.test(sql)) {
        pending = { ...pending, lead_status: 'Lost', loss_reason: values[1], status_before_hold: null, hold_reason: null, held_at: null };
        return { rows: [] };
      }
      if (/INSERT INTO lead_activities/.test(sql)) {
        if (failActivity) throw new Error('Activity storage failed');
        activities.push({ lead_id: values[0], content: values[2], actor_user_id: values[3], metadata: JSON.parse(values[5]) });
        return { rows: [activities.at(-1)] };
      }
      if (/FROM leads l/.test(sql)) return { rows: stored ? [{ ...stored, activities }] : [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const dependencies = {
    '../config/db_connection.js': { connect: async () => db, query: db.query },
    '../controller/settings.js': { getMasterSettings: async () => ({ loss_reasons: ['Price high', 'No response'] }) },
    '../services/notificationService.js': {},
  };
  for (const [file, exports] of Object.entries(dependencies)) {
    const filename = path.resolve(__dirname, file);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
  }
  const controllerPath = path.resolve(__dirname, '../controller/leads.js');
  delete require.cache[controllerPath];
  return { close: require(controllerPath).setLeadWorkflowState, calls, stored: () => stored };
}

const engineer = { id: 7, role: 'sales_engineer', name: 'Sales Engineer' };
const lead = { id: 22, lead_status: 'New', sales_owner_id: 7, company_name: 'Legacy customer' };

test('Closed Lost saves status, reason and audit without requiring unrelated legacy enquiry fields', async () => {
  for (const role of ['sales_engineer', 'sales_head', 'admin', 'presales', 'salesperson']) {
    const app = workflow(lead);
    const saved = await app.close(22, { action: 'lost', reason: 'Price high' }, { ...engineer, role });
    assert.equal(saved.lead_status, 'Lost');
    assert.equal(saved.loss_reason, 'Price high');
    assert.equal(saved.company_name, lead.company_name);
    assert.equal(saved.activities[0].actor_user_id, 7);
    assert.equal(saved.activities[0].metadata.event, 'lead_lost');
    assert.match(saved.activities[0].content, /Price high/);
    assert.equal(app.calls.some(({ sql }) => sql === 'COMMIT'), true);
  }
});

test('closing a held lead removes stale hold state', async () => {
  const app = workflow({ ...lead, lead_status: 'On Hold', status_before_hold: 'New', hold_reason: 'Waiting', held_at: '2026-11-01' });
  const saved = await app.close(22, { action: 'lost', reason: 'No response' }, engineer);
  assert.equal(saved.lead_status, 'Lost');
  assert.equal(saved.hold_reason, null);
  assert.equal(saved.status_before_hold, null);
});

test('another Sales Engineer cannot close the lead', async () => {
  const app = workflow(lead);
  await assert.rejects(app.close(22, { action: 'lost', reason: 'Price high' }, { ...engineer, id: 8 }), { statusCode: 403 });
  assert.equal(app.stored().lead_status, 'New');
  assert.equal(app.calls.some(({ sql }) => /UPDATE leads/.test(sql)), false);
});

test('missing or unconfigured loss reasons never update the lead', async () => {
  for (const reason of ['', 'Unconfigured reason']) {
    const app = workflow(lead);
    await assert.rejects(app.close(22, { action: 'lost', reason }, engineer), { statusCode: 400 });
    assert.equal(app.stored().lead_status, 'New');
    assert.equal(app.calls.some(({ sql }) => /UPDATE leads/.test(sql)), false);
  }
});

test('missing lead returns a useful error', async () => {
  const app = workflow(null);
  await assert.rejects(app.close(22, { action: 'lost', reason: 'Price high' }, engineer), { statusCode: 404 });
});

test('failed audit rolls back the Closed Lost save', async () => {
  const app = workflow(lead, { failActivity: true });
  await assert.rejects(app.close(22, { action: 'lost', reason: 'Price high' }, engineer), /Activity storage failed/);
  assert.equal(app.stored().lead_status, 'New');
  assert.equal(app.calls.some(({ sql }) => sql === 'ROLLBACK'), true);
  assert.equal(app.calls.some(({ sql }) => sql === 'COMMIT'), false);
});
