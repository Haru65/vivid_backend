const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const databasePath = path.resolve(__dirname, '../config/db_connection.js');
const servicePath = path.resolve(__dirname, '../services/estimationService.js');

function loadService({ engineer, requests }) {
  const calls = [];
  const pool = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/FROM users WHERE id/.test(sql)) return { rows: engineer ? [engineer] : [] };
      if (/FROM estimation_requests\s+WHERE id = ANY/.test(sql)) return { rows: requests };
      if (/UPDATE estimation_requests AS request/.test(sql)) {
        return { rows: values[0].map((id, index) => ({ id, priority_order: index + 1 })) };
      }
      throw new Error(`Unexpected SQL in estimation priority test: ${sql}`);
    },
  };
  require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: pool, children: [], paths: [] };
  delete require.cache[servicePath];
  return { service: require(servicePath), calls };
}

test('Estimation Head can persist an estimation engineer enquiry order', async () => {
  const { service, calls } = loadService({
    engineer: { id: 8, first_name: 'Estimate', last_name: 'Engineer', role: 'estimation_engineer' },
    requests: [
      { id: 22, assigned_engineer_id: 8 },
      { id: 11, assigned_engineer_id: 8 },
    ],
  });

  await service.reorderTeamPriorities(
    { team: 'estimation', engineer_id: 8, request_ids: [22, 11] },
    { id: 2, role: 'estimation_head' },
  );

  const update = calls.find((call) => /UPDATE estimation_requests AS request/.test(call.sql));
  assert.deepEqual(update.values[0], [22, 11]);
  assert.match(update.sql, /estimation_priority_order/);
});

test('Sales Head cannot change estimation engineer priorities', async () => {
  const { service, calls } = loadService({ engineer: null, requests: [] });

  await assert.rejects(
    service.reorderTeamPriorities(
      { team: 'estimation', engineer_id: 8, request_ids: [22] },
      { id: 3, role: 'sales_head' },
    ),
    (error) => error.statusCode === 403 && /Estimation Head/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test('Estimation Manager cannot change team priorities', async () => {
  const { service, calls } = loadService({ engineer: null, requests: [] });

  await assert.rejects(
    service.reorderTeamPriorities(
      { team: 'estimation', engineer_id: 8, request_ids: [22] },
      { id: 4, role: 'estimation_manager' },
    ),
    (error) => error.statusCode === 403 && /Estimation Head/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test('Sales Head can persist a sales engineer enquiry order', async () => {
  const { service, calls } = loadService({
    engineer: { id: 14, first_name: 'Sales', last_name: 'Engineer', role: 'sales_engineer' },
    requests: [
      { id: 35, sales_owner_id: 14 },
      { id: 21, requested_by_user_id: 14 },
    ],
  });

  await service.reorderTeamPriorities(
    { team: 'sales', engineer_id: 14, request_ids: [35, 21] },
    { id: 3, role: 'sales_head' },
  );

  const update = calls.find((call) => /UPDATE estimation_requests AS request/.test(call.sql));
  assert.deepEqual(update.values[0], [35, 21]);
  assert.match(update.sql, /sales_priority_order/);
});

