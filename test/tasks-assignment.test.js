const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const databasePath = path.resolve(__dirname, '../config/db_connection.js');
const controllerPath = path.resolve(__dirname, '../controller/tasks.js');
const notificationServicePath = path.resolve(__dirname, '../services/notificationService.js');

function loadController() {
  const calls = [];
  const notifications = [];
  const pool = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/FROM customers/.test(sql)) return { rows: [{ id: 3, company_name: 'Vivid Client', contact_person_name: 'Client Contact', contact_person_phone: '9999999999' }] };
      if (/FROM users/.test(sql)) return { rows: [{ id: 9, first_name: 'Sales', last_name: 'Engineer', role: 'sales_engineer' }] };
      if (/MAX\(sort_order\)/.test(sql)) return { rows: [{ next_order: 4 }] };
      if (/INSERT INTO visit_tasks/.test(sql)) return { rows: [{
        id: 81,
        customer_id: values[0],
        company_name: values[2],
        meeting_at: values[6],
        created_by_user_id: values[10],
        created_by_name: values[11],
        assigned_to_user_id: values[12],
        assigned_to_name: values[13],
        assigned_by_user_id: values[14],
        assigned_by_name: values[15],
        status: 'todo',
      }] };
      throw new Error(`Unexpected SQL in task assignment test: ${sql}`);
    },
  };
  require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: pool, children: [], paths: [] };
  require.cache[notificationServicePath] = { id: notificationServicePath, filename: notificationServicePath, loaded: true, exports: {
    notifyRole: async () => [],
    notifyUserId: async (userId, payload) => notifications.push({ userId, payload }),
  }, children: [], paths: [] };
  delete require.cache[controllerPath];
  return { controller: require(controllerPath), calls, notifications };
}

const taskData = {
  customer_id: 3,
  assigned_to_user_id: 9,
  location: 'Pune',
  reason_for_visit: 'Technical discussion',
  meeting_at: '2099-06-20T05:30:00.000Z',
  priority: 'high',
};

test('Sales Head assigns a new visit task and the engineer is notified', async () => {
  const { controller, calls, notifications } = loadController();
  const task = await controller.createTask(taskData, { id: 2, name: 'Sales Head', role: 'sales_head' });

  assert.equal(task.created_by_user_id, 2);
  assert.equal(task.assigned_to_user_id, 9);
  assert.equal(task.assigned_to_name, 'Sales Engineer');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].userId, 9);
  assert.equal(notifications[0].payload.link_type, 'task');
  assert.match(notifications[0].payload.title, /assigned/i);
  assert.match(calls.find((call) => /INSERT INTO visit_tasks/.test(call.sql)).sql, /assigned_to_user_id/);
});

test('a Sales Engineer creating a task is always assigned to themselves', async () => {
  const { controller, calls, notifications } = loadController();
  const task = await controller.createTask(
    { ...taskData, assigned_to_user_id: 999 },
    { id: 7, name: 'Own Engineer', role: 'sales_engineer' },
  );

  assert.equal(task.assigned_to_user_id, 7);
  assert.equal(task.assigned_to_name, 'Own Engineer');
  assert.equal(notifications.length, 0);
  assert.equal(calls.some((call) => /FROM users/.test(call.sql)), false);
});
