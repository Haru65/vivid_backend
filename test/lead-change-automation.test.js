const assert = require('node:assert/strict');
const test = require('node:test');
const { processLeadChangeDeadlines } = require('../services/leadChangeAutomationService');

test('lead change deadline sends a reminder and automatically approves expired requests', async () => {
  const notifications = [];
  const reviews = [];
  const updates = [];
  const db = {
    async query(sql, values) {
      if (/SELECT id, company_name, estimation_head_id, due_at/.test(sql)) {
        return { rows: [{ id: 10, company_name: 'Acme', estimation_head_id: 3, due_at: '2026-01-04T12:00:00.000Z' }] };
      }
      if (/SET reminder_sent_at/.test(sql)) return { rows: [{ id: values[0] }] };
      if (/SELECT id, estimation_head_id/.test(sql)) return { rows: [{ id: 11, estimation_head_id: 3 }] };
      if (/SET auto_approved_at/.test(sql)) {
        updates.push(values[0]);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const result = await processLeadChangeDeadlines(db, new Date('2026-01-03T12:00:00.000Z'), {
    notifyUserId: async (userId, payload) => notifications.push({ userId, payload }),
    reviewLeadChange: async (id, decision, comments, user) => {
      reviews.push({ id, decision, comments, user });
      return { status: 'applied' };
    },
    reviewDependencies: {},
  });

  assert.deepEqual(result, { reminded: 1, autoApproved: 1 });
  assert.equal(notifications[0].userId, 3);
  assert.match(notifications[0].payload.title, /due within 1 day/i);
  assert.deepEqual(updates, [11]);
  assert.equal(reviews[0].decision, 'approve');
  assert.match(reviews[0].comments, /3-day approval deadline/i);
  assert.equal(reviews[0].user.name, 'System auto-approval');
});
