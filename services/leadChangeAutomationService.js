const pool = require('../config/db_connection');
const { notifyUserId } = require('./notificationService');
const { reviewLeadChange } = require('./leadChangeService');

async function processLeadChangeDeadlines(db = pool, now = new Date(), dependencies = {}) {
  const timestamp = now.toISOString();
  const sendNotification = dependencies.notifyUserId || notifyUserId;
  const reminderRows = await db.query(
    `SELECT id, company_name, estimation_head_id, due_at
     FROM lead_change_requests
     WHERE status = 'pending'
       AND reminder_sent_at IS NULL
       AND due_at > $1::timestamptz
       AND due_at <= $1::timestamptz + INTERVAL '1 day'
     ORDER BY due_at ASC`,
    [timestamp],
  );
  let reminded = 0;
  for (const request of reminderRows.rows) {
    const claimed = await db.query(
      `UPDATE lead_change_requests
       SET reminder_sent_at = $2::timestamptz
       WHERE id = $1 AND status = 'pending' AND reminder_sent_at IS NULL
       RETURNING id`,
      [request.id, timestamp],
    );
    if (!claimed.rows[0]) continue;
    await sendNotification(request.estimation_head_id, {
      title: 'Lead approval due within 1 day',
      body: `${request.company_name}: approve the selected make/product change before the 3-day deadline. It will be approved automatically at the deadline.`,
      category: 'lead_change',
      link_type: 'lead_change_request',
      link_id: request.id,
      metadata: { due_at: request.due_at, automatic_approval: true },
    }, db);
    reminded += 1;
  }

  const expiredRows = await db.query(
    `SELECT id, estimation_head_id
     FROM lead_change_requests
     WHERE status = 'pending' AND due_at <= $1::timestamptz
     ORDER BY due_at ASC`,
    [timestamp],
  );
  let autoApproved = 0;
  const review = dependencies.reviewLeadChange || reviewLeadChange;
  const reviewDependencies = dependencies.reviewDependencies || { pool: db };
  for (const request of expiredRows.rows) {
    try {
      const result = await review(request.id, 'approve', 'Automatically approved after the 3-day approval deadline.', {
        id: request.estimation_head_id,
        name: 'System auto-approval',
        role: 'estimation_head',
      }, reviewDependencies);
      if (result?.status !== 'applied') continue;
      await db.query(
        `UPDATE lead_change_requests
         SET auto_approved_at = $2::timestamptz
         WHERE id = $1 AND status = 'applied'`,
        [request.id, timestamp],
      );
      autoApproved += 1;
    } catch (error) {
      if (error.statusCode !== 409) console.error(`Unable to auto-approve lead change #${request.id}:`, error);
    }
  }
  return { reminded, autoApproved };
}

module.exports = { processLeadChangeDeadlines };
