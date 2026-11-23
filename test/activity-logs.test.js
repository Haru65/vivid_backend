const assert = require('node:assert/strict');
const test = require('node:test');
const { listActivityLogs } = require('../services/activityLogService');

function database({ memberRole = 'estimation_engineer', assignedEngineerId = 14 } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/FROM users WHERE id/.test(sql)) return { rows: [{ id: 14, name: 'Test Engineer', role: memberRole }] };
      if (/SELECT \* FROM estimation_requests/.test(sql)) return { rows: [{ lead_id: 22, assigned_engineer_id: assignedEngineerId, sales_owner_id: assignedEngineerId, estimation_head_id: assignedEngineerId }] };
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

for (const role of ['admin', 'estimation_head', 'estimation_manager', 'sales_head']) {
  const memberRole = role === 'sales_head' ? 'sales_engineer' : 'estimation_engineer';
  test(`${role} project trail includes all actors and event types for the authorized project`, async () => {
    const db = database({ memberRole });
    await listActivityLogs({ scope: 'team_dashboard', actor_id: '14', lead_id: '22' }, { id: 3, role }, db);
    const activityQueries = db.calls.filter((call) => /FROM lead_activities/.test(call.sql));
    assert.equal(activityQueries.length, 4);
    for (const call of activityQueries) {
      assert.match(call.sql, /a\.lead_id = \$1/);
      assert.doesNotMatch(call.sql, /a\.actor_user_id =|activity_type IN|u\.role =/);
      assert.equal(call.values[0], 22);
    }
  });

  test(`${role} engineer overview remains limited to the selected actor`, async () => {
    const db = database({ memberRole });
    await listActivityLogs({ scope: 'team_dashboard', actor_id: '14' }, { id: 3, role }, db);
    for (const call of db.calls.filter((entry) => /FROM lead_activities/.test(entry.sql))) {
      assert.match(call.sql, /a\.actor_user_id = \$1/);
      assert.doesNotMatch(call.sql, /activity_type IN/);
      assert.equal(call.values[0], 14);
    }
  });
}

test('project trail rejects projects unrelated to the selected engineer before reading logs', async () => {
  const db = database({ assignedEngineerId: 99 });
  await assert.rejects(listActivityLogs({ scope: 'team_dashboard', actor_id: '14', lead_id: '22' }, { id: 3, role: 'estimation_manager' }, db), { statusCode: 403 });
  assert.equal(db.calls.some((call) => /FROM lead_activities/.test(call.sql)), false);
});

test('manager cannot use general logs or view managers, heads, or their own overview', async () => {
  for (const memberRole of ['estimation_manager', 'estimation_head']) {
    const db = database({ memberRole });
    await assert.rejects(listActivityLogs({ scope: 'team_dashboard', actor_id: '14' }, { id: 3, role: 'estimation_manager' }, db), { statusCode: 403 });
  }
  await assert.rejects(listActivityLogs({}, { id: 3, role: 'estimation_manager' }, database()), { statusCode: 403 });
  await assert.rejects(listActivityLogs({ scope: 'team_dashboard', actor_id: '14' }, { id: 14, role: 'estimation_manager' }, database()), { statusCode: 403 });
});

test('head can inspect managers but cannot inspect another head through the dashboard', async () => {
  await listActivityLogs({ scope: 'team_dashboard', actor_id: '14', lead_id: '22' }, { id: 3, role: 'estimation_head' }, database({ memberRole: 'estimation_manager' }));
  await assert.rejects(listActivityLogs({ scope: 'team_dashboard', actor_id: '14' }, { id: 3, role: 'estimation_head' }, database({ memberRole: 'estimation_head' })), { statusCode: 403 });
});

test('admin can inspect projects assigned to the estimation head', async () => {
  await listActivityLogs({ scope: 'team_dashboard', actor_id: '14', lead_id: '22' }, { id: 1, role: 'admin' }, database({ memberRole: 'estimation_head' }));
});

test('invalid project and missing member cannot fall back to unrestricted dashboard logs', async () => {
  for (const query of [{ actor_id: '14', lead_id: 'invalid' }, { lead_id: '22' }]) {
    const db = database();
    await assert.rejects(listActivityLogs({ scope: 'team_dashboard', ...query }, { id: 1, role: 'admin' }, db), { statusCode: 400 });
    assert.equal(db.calls.length, 0);
  }
});
