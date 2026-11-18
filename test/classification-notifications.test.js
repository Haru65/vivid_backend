const assert = require('node:assert/strict');
const test = require('node:test');
const { notifyLeadClassificationChange } = require('../services/notificationService');

test('classification changes notify assigned sales and estimation users except the actor', async () => {
  const inserts = [];
  const db = {
    async query(sql, values) {
      if (/SELECT DISTINCT u\.id/.test(sql)) {
        assert.deepEqual(values, [42, 9]);
        assert.match(sql, /sales_owner_id/);
        assert.match(sql, /assigned_engineer_id/);
        assert.match(sql, /estimation_head_id/);
        return { rows: [
          { id: 2, first_name: 'Sales', last_name: 'Engineer' },
          { id: 3, first_name: 'Estimation', last_name: 'Engineer' },
          { id: 4, first_name: 'Estimation', last_name: 'Head' },
        ] };
      }
      if (/INSERT INTO user_notifications/.test(sql)) {
        inserts.push(values);
        return { rows: [{ id: inserts.length }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const notifications = await notifyLeadClassificationChange({
    leadId: 42,
    companyName: 'Acme',
    projectName: 'Control Panel',
    previousClassification: 'Purchase',
    nextClassification: 'Tender',
    changedBy: { id: 9, name: 'Sales Head' },
  }, db);

  assert.equal(notifications.length, 3);
  assert.equal(inserts.length, 3);
  assert.ok(inserts.every((values) => values[2] === 'Assigned lead classification changed'));
  assert.ok(inserts.every((values) => values[3].includes('Purchase to Tender')));
  assert.ok(inserts.every((values) => JSON.parse(values[7]).event === 'lead_classification_changed'));
});

test('unchanged classification creates no notification', async () => {
  const db = { query: async () => { throw new Error('Database should not be queried'); } };
  assert.deepEqual(await notifyLeadClassificationChange({
    leadId: 42,
    previousClassification: 'Budget',
    nextClassification: 'Budget',
    changedBy: { id: 9, name: 'Sales Head' },
  }, db), []);
});
