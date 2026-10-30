const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const databasePath = path.resolve(__dirname, '../config/db_connection.js');
const controllerPath = path.resolve(__dirname, '../controller/tasks.js');
const notificationServicePath = path.resolve(__dirname, '../services/notificationService.js');

function loadController(initialTask) {
  const calls = [];
  const pool = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/FROM visit_tasks WHERE id = \$1/.test(sql)) return { rows: initialTask ? [{ ...initialTask }] : [] };
      if (/UPDATE visit_tasks/.test(sql)) {
        return { rows: [{ ...initialTask, meeting_at: values[0], all_day: values[1], updated_at: new Date().toISOString() }] };
      }
      throw new Error(`Unexpected SQL in task reschedule test: ${sql}`);
    },
  };

  require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: pool, children: [], paths: [] };
  require.cache[notificationServicePath] = { id: notificationServicePath, filename: notificationServicePath, loaded: true, exports: { notifyRole: async () => [], notifyUserId: async () => null }, children: [], paths: [] };
  delete require.cache[controllerPath];
  return { controller: require(controllerPath), calls };
}

const engineerTask = {
  id: 41,
  created_by_user_id: 7,
  created_by_name: 'Sales Engineer',
  status: 'todo',
  meeting_at: '2099-01-10T05:30:00.000Z',
  all_day: false,
};

test('admin can reschedule a Sales Engineer task without editing task details', async () => {
  const { controller, calls } = loadController(engineerTask);
  const result = await controller.rescheduleTask(
    engineerTask.id,
    { meeting_at: '2099-02-15T08:30:00.000Z', all_day: false },
    { id: 1, role: 'admin', name: 'Admin' },
  );

  assert.equal(result.id, engineerTask.id);
  assert.equal(result.meeting_at, '2099-02-15T08:30:00.000Z');
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /SET meeting_at = \$1/);
  assert.match(calls[1].sql, /status <> 'cancelled'/);
  assert.deepEqual(calls[1].values, ['2099-02-15T08:30:00.000Z', false, engineerTask.id]);
});

test('another Sales Engineer cannot reschedule someone else task', async () => {
  const { controller, calls } = loadController(engineerTask);
  await assert.rejects(
    controller.rescheduleTask(engineerTask.id, { meeting_at: '2099-02-15T08:30:00.000Z' }, { id: 8, role: 'sales_engineer' }),
    { statusCode: 403 },
  );
  assert.equal(calls.length, 1);
});

test('cancelled tasks cannot be rescheduled by an admin', async () => {
  const { controller, calls } = loadController({ ...engineerTask, status: 'cancelled' });
  await assert.rejects(
    controller.rescheduleTask(engineerTask.id, { meeting_at: '2099-02-15T08:30:00.000Z' }, { id: 1, role: 'admin' }),
    { statusCode: 409 },
  );
  assert.equal(calls.length, 1);
});

test('admin reschedule rejects an invalid meeting date before updating', async () => {
  const { controller, calls } = loadController(engineerTask);
  await assert.rejects(
    controller.rescheduleTask(engineerTask.id, { meeting_at: 'not-a-date' }, { id: 1, role: 'admin' }),
    { statusCode: 400 },
  );
  assert.equal(calls.length, 1);
});
