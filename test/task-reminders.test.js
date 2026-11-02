const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const reminderPath = path.resolve(__dirname, '../services/taskReminderService.js');
const notificationPath = path.resolve(__dirname, '../services/notificationService.js');

function loadReminderService() {
  const notifications = [];
  require.cache[notificationPath] = {
    id: notificationPath,
    filename: notificationPath,
    loaded: true,
    exports: {
      createNotification: async (recipient, payload) => {
        notifications.push({ recipient, payload });
        return { id: notifications.length, ...payload };
      },
    },
    children: [],
    paths: [],
  };
  delete require.cache[reminderPath];
  return { service: require(reminderPath), notifications };
}

test('Monday sends each Sales Head one task-plan review notification', async () => {
  const { service, notifications } = loadReminderService();
  const claimed = new Set();
  const db = {
    async query(sql, values = []) {
      if (/role = 'sales_head'/.test(sql)) return { rows: [{ id: 10, first_name: 'Sales', last_name: 'Head' }] };
      if (/COUNT\(\*\)::int AS visits/.test(sql)) return { rows: [{ visits: 8, engineers: 3 }] };
      if (/INSERT INTO task_planning_reminders/.test(sql)) {
        const key = values.join(':');
        if (claimed.has(key)) return { rows: [] };
        claimed.add(key);
        return { rows: [{ id: claimed.size }] };
      }
      throw new Error(`Unexpected reminder query: ${sql}`);
    },
  };

  const monday = new Date('2026-11-02T04:00:00.000Z');
  const first = await service.sendMondayTaskReviewReminders(db, monday);
  const second = await service.sendMondayTaskReviewReminders(db, monday);

  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].payload.category, 'task_planning_review');
  assert.equal(notifications[0].payload.link_type, 'task_planning');
  assert.match(notifications[0].payload.body, /8 visits planned by 3 sales engineers/);
});

test('Monday review reminder is skipped on other weekdays', async () => {
  const { service } = loadReminderService();
  const result = await service.sendMondayTaskReviewReminders({ query: async () => { throw new Error('Should not query'); } }, new Date('2026-11-03T04:00:00.000Z'));
  assert.deepEqual(result, { sent: 0, skipped: true });
});
