
const pool = require('../config/db_connection');

function actorName(user) {
  return String(user?.name || '').trim();
}

function appError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizePayload(data = {}) {
  return {
    title: String(data.title || '').trim().slice(0, 255),
    body: data.body ? String(data.body).trim() : null,
    category: String(data.category || 'general').trim().slice(0, 50) || 'general',
    linkType: data.link_type ? String(data.link_type).trim().slice(0, 50) : null,
    linkId: data.link_id ? Number(data.link_id) : null,
    metadata: data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata) ? data.metadata : {},
  };
}

async function createNotification(recipient, data, db = pool) {
  const payload = normalizePayload(data);
  if (!payload.title) return null;
  let recipientId = recipient?.id ? Number(recipient.id) : null;
  let recipientName = actorName(recipient) || (recipient?.name ? String(recipient.name).trim() : null);
  if (!recipientId && recipientName) {
    const match = await db.query(
      `SELECT id, first_name, last_name
       FROM users
       WHERE is_active = TRUE
         AND LOWER(TRIM(CONCAT_WS(' ', first_name, last_name))) = LOWER(TRIM($1))
       ORDER BY id ASC
       LIMIT 1`,
      [recipientName],
    );
    if (match.rows[0]) {
      recipientId = Number(match.rows[0].id);
      recipientName = [match.rows[0].first_name, match.rows[0].last_name].filter(Boolean).join(' ');
    }
  }
  if (!recipientId) return null;
  const result = await db.query(
    `INSERT INTO user_notifications (
      recipient_user_id, recipient_name, title, body, category, link_type, link_id, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *`,
    [recipientId, recipientName, payload.title, payload.body, payload.category, payload.linkType, payload.linkId, JSON.stringify(payload.metadata)],
  );
  return result.rows[0];
}

async function notifyUserId(userId, data, db = pool) {
  if (!userId) return null;
  const user = await db.query(
    `SELECT id, first_name, last_name FROM users WHERE id = $1 AND is_active = TRUE`,
    [userId],
  );
  const row = user.rows[0];
  if (!row) return null;
  return createNotification({ id: row.id, name: [row.first_name, row.last_name].filter(Boolean).join(' ') }, data, db);
}

async function notifyRole(role, data, db = pool) {
  const result = await db.query(
    `SELECT id, first_name, last_name FROM users WHERE role = $1 AND is_active = TRUE`,
    [role],
  );
  return Promise.all(result.rows.map((row) => createNotification({
    id: row.id,
    name: [row.first_name, row.last_name].filter(Boolean).join(' '),
  }, data, db)));
}

async function notifyLeadClassificationChange({
  leadId,
  companyName,
  projectName,
  previousClassification,
  nextClassification,
  changedBy,
}, db = pool) {
  if (!leadId || previousClassification === nextClassification) return [];
  const result = await db.query(
    `SELECT DISTINCT u.id, u.first_name, u.last_name
     FROM users u
     WHERE u.is_active = TRUE
       AND u.id <> $2
       AND u.id IN (
         SELECT NULLIF(to_jsonb(l)->>'sales_owner_id', '')::BIGINT FROM leads l WHERE l.id = $1
         UNION
         SELECT er.assigned_engineer_id FROM estimation_requests er
           WHERE er.lead_id = $1 AND er.status NOT IN ('cancelled', 'discarded', 'dropped')
         UNION
         SELECT er.estimation_head_id FROM estimation_requests er
           WHERE er.lead_id = $1 AND er.status NOT IN ('cancelled', 'discarded', 'dropped')
       )`,
    [leadId, changedBy?.id || 0],
  );
  const subject = projectName || companyName || `Lead #${leadId}`;
  return Promise.all(result.rows.map((recipient) => createNotification({
    id: recipient.id,
    name: [recipient.first_name, recipient.last_name].filter(Boolean).join(' '),
  }, {
    title: 'Assigned lead classification changed',
    body: `${changedBy?.name || 'A workspace user'} changed ${subject} from ${previousClassification || 'Unspecified'} to ${nextClassification || 'Unspecified'}.`,
    category: 'lead',
    link_type: 'lead',
    link_id: leadId,
    metadata: {
      event: 'lead_classification_changed',
      previous_classification: previousClassification || null,
      next_classification: nextClassification || null,
      changed_by_user_id: changedBy?.id || null,
    },
  }, db)));
}

async function listNotifications(user) {
  const result = await pool.query(
    `SELECT *
     FROM user_notifications
     WHERE recipient_user_id = $1
     ORDER BY read_at NULLS FIRST, created_at DESC, id DESC
     LIMIT 80`,
    [user?.id || null],
  );
  return result.rows;
}

async function markNotificationRead(id, user) {
  const result = await pool.query(
    `UPDATE user_notifications
     SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
     WHERE id = $1
       AND recipient_user_id = $2
     RETURNING *`,
    [id, user?.id || null],
  );
  if (!result.rows[0]) throw appError('Notification not found.', 404);
  return result.rows[0];
}

async function markAllNotificationsRead(user) {
  const result = await pool.query(
    `UPDATE user_notifications
     SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
     WHERE read_at IS NULL
       AND recipient_user_id = $1
     RETURNING *`,
    [user?.id || null],
  );
  return { updated: result.rowCount, notifications: result.rows };
}

module.exports = {
  createNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notifyLeadClassificationChange,
  notifyRole,
  notifyUserId,
};
