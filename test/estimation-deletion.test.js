const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function mock(relativePath, exports) {
  const filename = path.resolve(__dirname, relativePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

function setup({ status = 'dropped', dependencies = {} } = {}) {
  const statements = [];
  const activities = [];
  const request = {
    id: 41,
    lead_id: 17,
    quotation_id: 22,
    quotation_number: 'QT-22',
    status,
    company_name: 'Delete Test Customer',
  };
  const query = async (sql, values = []) => {
    statements.push({ sql, values });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (/SELECT er\.id, er\.lead_id/.test(sql)) return { rows: [request] };
    if (/AS has_frontsheet/.test(sql)) {
      return { rows: [{
        has_frontsheet: false,
        has_handover: false,
        has_project: false,
        has_negotiation: false,
        quotation_shared: false,
        ...dependencies,
      }] };
    }
    if (/^(DELETE|UPDATE)/.test(sql.trim())) return { rows: [] };
    throw new Error(`Unexpected estimation deletion query: ${sql}`);
  };
  mock('../config/db_connection.js', { query, connect: async () => ({ query, release() {} }) });
  mock('../controller/quotations.js', {});
  mock('../controller/leads.js', { logLeadActivity: async (leadId, activity) => activities.push({ leadId, ...activity }) });
  mock('../services/notificationService.js', {});
  mock('../controller/settings.js', { getMasterSettings: async () => ({}) });
  const servicePath = path.resolve(__dirname, '../services/estimationService.js');
  delete require.cache[servicePath];
  return { service: require(servicePath), statements, activities };
}

for (const role of ['estimation_head', 'estimation_manager']) {
  test(`${role} can permanently delete a dropped estimation and its owned quotation data`, async () => {
    const app = setup();
    const result = await app.service.deleteEstimationRequest(41, { id: 5, role, name: 'Estimator Lead' });
    assert.deepEqual(result, { id: 41, lead_id: 17, quotation_id: 22, deleted: true });
    const mutations = app.statements.map(({ sql }) => sql.trim()).filter((sql) => /^(DELETE|UPDATE)/.test(sql));
    assert.match(mutations[0], /DELETE FROM user_notifications/);
    assert.match(mutations[1], /DELETE FROM estimation_quote_uploads/);
    assert.match(mutations[2], /DELETE FROM estimation_requests/);
    assert.match(mutations[3], /DELETE FROM quotations/);
    assert.match(mutations[4], /UPDATE leads SET quotation = NULL/);
    assert.match(app.activities[0].content, /permanently deleted/);
    assert.equal(app.statements.at(-1).sql, 'COMMIT');
  });
}

for (const role of ['admin', 'sales_head', 'estimation_engineer']) {
  test(`${role} cannot delete an estimation`, async () => {
    const app = setup();
    await assert.rejects(
      app.service.deleteEstimationRequest(41, { id: 1, role, name: 'Not Allowed' }),
      (error) => error.statusCode === 403,
    );
    assert.equal(app.statements.length, 0);
  });
}

test('an active estimation must be dropped before permanent deletion', async () => {
  const app = setup({ status: 'in_progress' });
  await assert.rejects(
    app.service.deleteEstimationRequest(41, { id: 5, role: 'estimation_head', name: 'Head' }),
    (error) => error.statusCode === 409 && /Drop the estimation/.test(error.message),
  );
  assert.equal(app.statements.at(-1).sql, 'ROLLBACK');
});

test('downstream Frontsheet, ERP, project, or negotiation history blocks deletion', async () => {
  for (const dependency of ['has_frontsheet', 'has_handover', 'has_project', 'has_negotiation']) {
    const app = setup({ dependencies: { [dependency]: true } });
    await assert.rejects(
      app.service.deleteEstimationRequest(41, { id: 5, role: 'estimation_manager', name: 'Manager' }),
      (error) => error.statusCode === 409,
    );
    assert.equal(app.statements.some(({ sql }) => /DELETE FROM estimation_requests/.test(sql)), false);
    assert.equal(app.statements.at(-1).sql, 'ROLLBACK');
  }
});
