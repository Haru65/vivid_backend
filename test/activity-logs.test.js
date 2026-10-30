const assert = require('node:assert/strict');
const test = require('node:test');
const { listActivityLogs } = require('../services/activityLogService');

function database() {
  const calls = [];
  return {
    calls,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 0 }] };
      if (/SELECT DISTINCT activity_type/.test(sql)) return { rows: [{ activity_type: 'approval' }, { activity_type: 'approval_requested' }] };
      if (/SELECT actor_name/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

test('Estimation Head activity trail is restricted to approval events', async () => {
  const db = database();
  const result = await listActivityLogs({ type: 'system' }, { id: 3, role: 'estimation_head' }, db);

  assert.deepEqual(result.activity_types, ['approval', 'approval_requested']);
  assert.equal(db.calls.length, 4);
  for (const call of db.calls) {
    assert.match(call.sql, /activity_type IN \('approval_requested', 'approval'\)/);
  }
});

test('Admin activity trail remains unrestricted', async () => {
  const db = database();
  await listActivityLogs({}, { id: 1, role: 'admin' }, db);

  assert.equal(db.calls.some((call) => /activity_type IN \('approval_requested', 'approval'\)/.test(call.sql)), false);
});

test('Estimation Head team dashboard is restricted to the selected engineer', async () => {
  const db = database();
  await listActivityLogs({ scope: 'team_dashboard', actor_id: '14' }, { id: 3, role: 'estimation_head' }, db);

  assert.equal(db.calls.some((call) => /activity_type IN \('approval_requested', 'approval'\)/.test(call.sql)), false);
  assert.match(db.calls[0].sql, /a\.actor_user_id = \$1/);
  assert.match(db.calls[0].sql, /u\.role IN \('salesperson', 'sales_engineer', 'presales', 'estimation_engineer'\)/);
  assert.equal(db.calls.every((call) => call.values.includes(14)), true);
});
