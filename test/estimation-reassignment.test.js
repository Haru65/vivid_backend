const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

function mock(relativePath, exports) {
  const filename = path.resolve(__dirname, relativePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

function setup(role = 'estimation_head', status = 'in_progress', statusBeforeHold = null) {
  const activities = [];
  const notifications = [];
  let request = {
    id: 72,
    lead_id: 31,
    status,
    status_before_hold: statusBeforeHold,
    company_name: 'Transfer Customer',
    enquiry_product: 'MCC Panel',
    assigned_engineer_id: 8,
    assigned_engineer_name: 'Old Engineer',
    assignment_notes: 'Original context',
    estimation_priority_order: 3,
    quotation_id: 91,
    quotation_number: 'QT-91',
    uploaded_quote_id: 44,
    uploaded_quote_remarks: 'Keep this remark',
    revision_notes: 'Keep revision history',
  };
  const query = async (sql, values = []) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (/FROM estimation_requests er/.test(sql)) return { rows: [{ ...request }] };
    if (/SELECT id, first_name, last_name FROM users/.test(sql)) {
      return { rows: values[0] === 9 ? [{ id: 9, first_name: 'New', last_name: 'Engineer' }] : [] };
    }
    if (/UPDATE estimation_requests/.test(sql) && /assigned_engineer_id/.test(sql)) {
      assert.match(sql, /status = CASE\s+WHEN \$7::boolean AND status = 'submitted_for_review' THEN 'in_progress'/);
      assert.match(sql, /WHEN \$7::boolean AND status = 'revision_submitted_for_review' THEN 'revision_in_progress'/);
      assert.match(sql, /status_before_hold = CASE/);
      assert.match(sql, /estimation_priority_order = CASE WHEN \$7::boolean THEN NULL/);
      const nextStatus = values[6]
        ? request.status === 'submitted_for_review'
          ? 'in_progress'
          : request.status === 'revision_submitted_for_review'
            ? 'revision_in_progress'
            : request.status
        : request.status === 'revision_requested' ? 'revision_requested' : 'assigned';
      request = {
        ...request,
        assigned_engineer_id: values[0],
        assigned_engineer_name: values[1],
        assignment_notes: values[4] || request.assignment_notes,
        status: nextStatus,
        status_before_hold: values[6] && request.status === 'on_hold'
          ? request.status_before_hold === 'submitted_for_review'
            ? 'in_progress'
            : request.status_before_hold === 'revision_submitted_for_review'
              ? 'revision_in_progress'
              : request.status_before_hold
          : request.status_before_hold,
        estimation_priority_order: values[6] ? null : request.estimation_priority_order,
      };
      return { rows: [{ ...request }] };
    }
    throw new Error(`Unexpected reassignment query: ${sql}`);
  };
  mock('../config/db_connection.js', { query, connect: async () => ({ query, release() {} }) });
  mock('../controller/quotations.js', {});
  mock('../controller/leads.js', { logLeadActivity: async (_leadId, activity) => activities.push(activity) });
  mock('../services/notificationService.js', {
    notifyUserId: async (userId, notification) => notifications.push({ userId, ...notification }),
  });
  mock('../controller/settings.js', { getMasterSettings: async () => ({}) });
  const servicePath = path.resolve(__dirname, '../services/estimationService.js');
  delete require.cache[servicePath];
  return {
    service: require(servicePath),
    actor: { id: role === 'estimation_manager' ? 5 : 4, role, name: role === 'estimation_manager' ? 'Manager' : 'Head' },
    state: () => request,
    activities,
    notifications,
  };
}

for (const role of ['estimation_head', 'estimation_manager']) {
  test(`${role} can replace the engineer without losing enquiry data or workflow state`, async () => {
    const app = setup(role);
    const saved = await app.service.assignRequest(72, { engineer_id: 9, assignment_notes: 'Continue from uploaded drawing' }, app.actor);
    assert.equal(saved.assigned_engineer_id, 9);
    assert.equal(saved.assigned_engineer_name, 'New Engineer');
    assert.equal(saved.status, 'in_progress');
    assert.equal(saved.quotation_id, 91);
    assert.equal(saved.uploaded_quote_id, 44);
    assert.equal(saved.uploaded_quote_remarks, 'Keep this remark');
    assert.equal(saved.revision_notes, 'Keep revision history');
    assert.equal(saved.estimation_priority_order, null);
    assert.match(app.activities[0].content, /Old Engineer → New Engineer/);
    assert.deepEqual(app.notifications.map(({ userId }) => userId), [8, 9]);
    assert.equal((await app.service.getRequest(72, { id: 9, role: 'estimation_engineer' })).id, 72);
    await assert.rejects(app.service.getRequest(72, { id: 8, role: 'estimation_engineer' }), (error) => error.statusCode === 403);
  });
}

test('the current engineer cannot be selected as their own replacement', async () => {
  const app = setup();
  await assert.rejects(app.service.assignRequest(72, { engineer_id: 8 }, app.actor), /different estimation engineer/);
  assert.equal(app.state().assigned_engineer_id, 8);
});

test('replacement reopens a submitted quotation so the new engineer can continue work', async () => {
  const app = setup('estimation_head', 'submitted_for_review');
  const saved = await app.service.assignRequest(72, { engineer_id: 9 }, app.actor);
  assert.equal(saved.status, 'in_progress');
  assert.equal(saved.assigned_engineer_id, 9);
  assert.equal(saved.uploaded_quote_id, 44);
});

test('replacement reopens a submitted revision for the new engineer', async () => {
  const app = setup('estimation_manager', 'revision_submitted_for_review');
  const saved = await app.service.assignRequest(72, { engineer_id: 9 }, app.actor);
  assert.equal(saved.status, 'revision_in_progress');
  assert.equal(saved.assigned_engineer_id, 9);
  assert.equal(saved.revision_notes, 'Keep revision history');
});

test('replacement updates the resume stage while the enquiry is on hold', async () => {
  const app = setup('estimation_head', 'on_hold', 'submitted_for_review');
  const saved = await app.service.assignRequest(72, { engineer_id: 9 }, app.actor);
  assert.equal(saved.status, 'on_hold');
  assert.equal(saved.status_before_hold, 'in_progress');
});
