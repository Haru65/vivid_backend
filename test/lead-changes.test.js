const assert = require('node:assert/strict');
const test = require('node:test');
const { leadSnapshot, changesBetween, submitLeadChange, reviewLeadChange, listLeadChanges } = require('../services/leadChangeService');

const salesHead = { id: 2, name: 'Sales Head', role: 'sales_head' };
const estimationHead = { id: 3, name: 'Estimation Head', role: 'estimation_head' };
const engineer = { id: 1, name: 'Sales Engineer', role: 'sales_engineer' };
const baseLead = { id: 7, company_name: 'Acme', project_name: 'Original project', sales_owner_id: 1, assigned_to: engineer.name, customer_id: 10, enquiry_date: '2026-10-26', lead_status: 'New', priority: 'Medium' };

function database() {
  const before = leadSnapshot(baseLead);
  const after = leadSnapshot({ ...baseLead, project_name: 'Revised project' });
  let state = {
    lead: structuredClone(baseLead),
    request: { id: 9, lead_id: 7, company_name: 'Acme', requested_by_user_id: 1, requested_by_name: engineer.name, sales_head_id: 2, estimation_head_id: 3, status: 'pending', before_snapshot: before, proposed_snapshot: after, changes: changesBetween(before, after), sales_approved_at: null, estimation_approved_at: null },
    activities: [], notifications: [], applications: 0,
  };
  let backup;
  const calls = [];
  const db = {
    get state() { return state; },
    calls,
    release() {},
    failNotifications: false,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql === 'BEGIN') { backup = structuredClone(state); return { rows: [] }; }
      if (sql === 'ROLLBACK') { state = backup; return { rows: [] }; }
      if (sql === 'COMMIT') return { rows: [] };
      if (/SELECT \* FROM lead_change_requests/.test(sql)) return { rows: state.request ? [structuredClone(state.request)] : [] };
      if (/SELECT \* FROM leads/.test(sql)) return { rows: state.lead ? [structuredClone(state.lead)] : [] };
      if (/SELECT id FROM lead_change_requests/.test(sql)) return { rows: state.request?.status === 'pending' ? [{ id: state.request.id }] : [] };
      if (/SELECT id FROM users/.test(sql)) return { rows: [{ id: values[0] === 'sales_head' ? 2 : 3 }] };
      if (/SELECT estimation_head_id FROM estimation_requests/.test(sql)) return { rows: [{ estimation_head_id: 3 }] };
      if (/SELECT assigned_engineer_id, estimation_head_id/.test(sql)) return { rows: [{ assigned_engineer_id: 4, estimation_head_id: 3 }] };
      if (/SELECT id, first_name, last_name FROM users/.test(sql)) return { rows: [{ id: values[0], first_name: 'User', last_name: String(values[0]) }] };
      if (/INSERT INTO user_notifications/.test(sql)) {
        if (db.failNotifications) throw new Error('Notification insert failed');
        state.notifications.push({ recipient: String(values[0]), title: values[2] });
        return { rows: [{ id: state.notifications.length }] };
      }
      if (/INSERT INTO lead_activities/.test(sql)) {
        state.activities.push({ type: values[1], user: values[2], content: values[4], metadata: JSON.parse(values[5]) });
        return { rows: [] };
      }
      if (/INSERT INTO lead_change_requests/.test(sql)) {
        state.request = { id: 9, lead_id: values[0], company_name: values[1], requested_by_user_id: values[2], requested_by_name: values[3], sales_head_id: values[4], estimation_head_id: values[5], before_snapshot: JSON.parse(values[6]), proposed_snapshot: JSON.parse(values[7]), changes: JSON.parse(values[8]), status: 'pending' };
        return { rows: [structuredClone(state.request)] };
      }
      if (/UPDATE lead_change_requests/.test(sql)) {
        if (/sales_approved_at =/.test(sql)) { state.request.sales_approved_at = '2026-10-26T10:00:00Z'; state.request.sales_comments = values[1]; }
        if (/estimation_approved_at =/.test(sql)) { state.request.estimation_approved_at = '2026-10-26T10:01:00Z'; state.request.estimation_comments = values[1]; }
        for (const status of ['applied', 'rejected', 'conflict']) {
          if (sql.includes(`status = '${status}'`)) state.request.status = status;
        }
        if (state.request.status === 'rejected') { state.request.rejected_by_user_id = values[1]; state.request.rejection_reason = values[2]; }
        return { rows: [structuredClone(state.request)] };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
  return db;
}

function dependencies(db, { failApply = false } = {}) {
  return {
    pool: { connect: async () => db },
    updateLead: async (id, proposed, user, options) => {
      assert.equal(id, 7);
      assert.equal(user.id, 1);
      assert.equal(options.db, db);
      assert.equal(options.approvedChangeId, 9);
      db.state.applications += 1;
      db.state.lead = { id: 7, ...proposed };
      if (failApply) throw new Error('Lead update failed');
      return db.state.lead;
    },
  };
}

test('lead snapshots compare dates, numeric IDs and nested JSON consistently', () => {
  const before = leadSnapshot({ ...baseLead, enquiry_date: new Date(2026, 9, 26), raw_data: { z: 2, a: 1 } });
  const after = leadSnapshot({ ...baseLead, sales_owner_id: '1', customer_id: '10', raw_data: { a: 1, z: 2 } });
  assert.deepEqual(changesBetween(before, after), {});
});

test('submission stores proposed values, keeps lead unchanged and notifies exactly the two selected heads', async () => {
  const db = database();
  db.state.request = null;
  const result = await submitLeadChange(db, baseLead, { ...baseLead, project_name: 'Revised project' }, engineer, { sales_head_id: 2, estimation_head_id: 3 });
  assert.equal(result.approval_required, true);
  assert.equal(db.state.lead.project_name, 'Original project');
  assert.equal(db.state.request.changes.project_name.after, 'Revised project');
  assert.deepEqual(db.state.notifications.map((item) => item.recipient), ['2', '3']);
  assert.equal(db.state.activities[0].type, 'approval_requested');
});

test('a pending request prevents a second request for the same lead', async () => {
  const db = database();
  await assert.rejects(submitLeadChange(db, baseLead, { ...baseLead, project_name: 'Another project' }, engineer), { statusCode: 409 });
  assert.equal(db.state.notifications.length, 0);
});

test('submission rejects an unrelated reviewer instead of broadcasting', async () => {
  const db = database();
  db.state.request = null;
  await assert.rejects(submitLeadChange(db, baseLead, { ...baseLead, priority: 'High' }, engineer, { sales_head_id: 99, estimation_head_id: 3 }), /Select an active Sales Head/);
  assert.equal(db.state.request, null);
  assert.equal(db.state.notifications.length, 0);
});

for (const [first, second] of [[salesHead, estimationHead], [estimationHead, salesHead]]) {
  test(`both heads required, with ${first.role} reviewing first`, async () => {
    const db = database();
    const deps = dependencies(db);
    const waiting = await reviewLeadChange(9, 'approve', 'Reviewed', first, deps);
    assert.equal(waiting.status, 'pending');
    assert.equal(db.state.lead.project_name, 'Original project');
    assert.equal(db.state.applications, 0);
    assert.equal(db.state.notifications.length, 0);
    const applied = await reviewLeadChange(9, 'approve', 'Confirmed', second, deps);
    assert.equal(applied.status, 'applied');
    assert.equal(db.state.lead.project_name, 'Revised project');
    assert.equal(db.state.applications, 1);
    assert.deepEqual(db.state.notifications.map((item) => item.recipient).sort(), ['1', '3', '4']);
    assert.ok(db.state.activities.some((item) => item.metadata.event === 'lead_change_applied' && item.content.includes('Original project → Revised project')));
    await assert.rejects(reviewLeadChange(9, 'approve', '', second, deps), { statusCode: 409 });
    assert.equal(db.state.applications, 1);
  });
}

test('unassigned heads, self-approval and administrator override cannot approve a request', async () => {
  const db = database();
  const deps = dependencies(db);
  for (const user of [{ ...salesHead, id: 99 }, engineer, { id: 10, name: 'Admin', role: 'admin' }]) {
    await assert.rejects(reviewLeadChange(9, 'approve', '', user, deps), { statusCode: 403 });
  }
  assert.equal(db.state.applications, 0);
});

test('one head cannot count as both approvals or approve twice', async () => {
  const db = database();
  await reviewLeadChange(9, 'approve', '', salesHead, dependencies(db));
  await assert.rejects(reviewLeadChange(9, 'approve', '', salesHead, dependencies(db)), { statusCode: 409 });
  assert.equal(db.state.applications, 0);
});

test('rejection preserves the lead and requires a reason', async () => {
  const db = database();
  await assert.rejects(reviewLeadChange(9, 'reject', ' ', salesHead, dependencies(db)), /rejection reason/);
  await reviewLeadChange(9, 'approve', '', salesHead, dependencies(db));
  const rejected = await reviewLeadChange(9, 'reject', 'Incorrect specification', estimationHead, dependencies(db));
  assert.equal(rejected.status, 'rejected');
  assert.equal(db.state.lead.project_name, 'Original project');
  assert.equal(db.state.applications, 0);
});

test('a stale lead is never overwritten by approved values', async () => {
  const db = database();
  await reviewLeadChange(9, 'approve', '', salesHead, dependencies(db));
  db.state.lead.project_name = 'Admin revision';
  const conflict = await reviewLeadChange(9, 'approve', '', estimationHead, dependencies(db));
  assert.equal(conflict.status, 'conflict');
  assert.equal(db.state.lead.project_name, 'Admin revision');
  assert.equal(db.state.applications, 0);
});

test('application failure rolls back the last vote, lead and audit entries together', async () => {
  const db = database();
  await reviewLeadChange(9, 'approve', '', salesHead, dependencies(db));
  const before = structuredClone(db.state);
  await assert.rejects(reviewLeadChange(9, 'approve', '', estimationHead, dependencies(db, { failApply: true })), /Lead update failed/);
  assert.deepEqual(db.state, before);
});

test('notification failure rolls back the applied lead and both-vote completion', async () => {
  const db = database();
  await reviewLeadChange(9, 'approve', '', salesHead, dependencies(db));
  const before = structuredClone(db.state);
  db.failNotifications = true;
  await assert.rejects(reviewLeadChange(9, 'approve', '', estimationHead, dependencies(db)), /Notification insert failed/);
  assert.deepEqual(db.state, before);
});

test('request listings use authenticated role and user ID, with assigned engineers limited to applied changes', async () => {
  let query;
  await listLeadChanges(engineer, { query: async (sql, values) => { query = { sql, values }; return { rows: [] }; } });
  assert.deepEqual(query.values, ['sales_engineer', 1]);
  assert.match(query.sql, /requested_by_user_id = \$2/);
  assert.match(query.sql, /r.status = 'applied' AND EXISTS/);
  await assert.rejects(listLeadChanges({ id: 1, role: 'erp' }), { statusCode: 403 });
});

test('API lead updates reject forged salesperson reassignment before any customer or lead write', async () => {
  const pool = require('../config/db_connection');
  const { updateLead } = require('../controller/leads');
  const originalConnect = pool.connect;
  const queries = [];
  pool.connect = async () => ({
    release() {},
    query: async (sql) => {
      queries.push(sql);
      if (/SELECT/.test(sql)) return { rows: [baseLead] };
      return { rows: [] };
    },
  });
  try {
    for (const user of [engineer, { id: 5, name: 'Presales', role: 'presales' }, { ...engineer, role: 'salesperson' }, { ...engineer, id: 9 }]) {
      await assert.rejects(updateLead(7, { sales_owner_id: 99, assigned_to: 'Other Person' }, user), { statusCode: 403 });
    }
    assert.equal(queries.some((sql) => /UPDATE leads|INSERT INTO/.test(sql)), false);
  } finally { pool.connect = originalConnect; }
});
