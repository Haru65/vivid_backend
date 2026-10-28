const pool = require('../config/db_connection');
const { notifyUserId } = require('./notificationService');

const LEAD_EDIT_FIELDS = [
  'company_name', 'contact_person_name', 'contact_person_email', 'contact_person_phone',
  'enquiry_date', 'priority', 'segment', 'site_location', 'consultant', 'enquiry_product',
  'enquiry_notes', 'industry_type', 'quotation', 'lead_source', 'lead_status',
  'requirements_summary', 'assigned_to', 'raw_data', 'enquiry_state', 'sales_approval_status',
  'loss_reason', 'project_name', 'billing_state', 'billing_district', 'billing_city',
  'billing_pincode', 'precise_location', 'customer_id', 'sales_owner_id',
];

function appError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value === '' || value === undefined ? null : value;
}

function leadSnapshot(lead) {
  return Object.fromEntries(LEAD_EDIT_FIELDS.map((field) => {
    let value = lead[field];
    if (field === 'enquiry_date' && value) value = value instanceof Date
      ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
      : String(value).slice(0, 10);
    if (['customer_id', 'sales_owner_id'].includes(field) && value) value = String(value);
    return [field, canonical(value)];
  }));
}

function changesBetween(before, after) {
  return Object.fromEntries(LEAD_EDIT_FIELDS
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map((field) => [field, { before: before[field], after: after[field] }]));
}

async function writeActivity(db, leadId, user, type, content, metadata) {
  await db.query(
    `INSERT INTO lead_activities (lead_id, activity_type, actor_user_id, actor_name, content, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [leadId, type, user.id, user.name, content, JSON.stringify(metadata)],
  );
}

async function chooseReviewer(db, role, requestedId, preferredId, requesterId) {
  const result = await db.query(
    `SELECT id FROM users WHERE is_active = TRUE AND role = $1 AND id <> $2 ORDER BY id`,
    [role, requesterId],
  );
  const choices = result.rows;
  const selected = requestedId || preferredId || (choices.length === 1 ? choices[0].id : null);
  if (!selected || !choices.some((row) => String(row.id) === String(selected))) {
    throw appError(`Select an active ${role === 'sales_head' ? 'Sales Head' : 'Estimation Head'} to approve this change.`);
  }
  return selected;
}

// Called while the lead is locked inside updateLead's transaction.
async function submitLeadChange(db, previous, proposed, user, reviewers = {}) {
  const before = leadSnapshot(previous);
  const after = leadSnapshot(proposed);
  const changes = changesBetween(before, after);
  if (!Object.keys(changes).length) return previous;
  const pending = await db.query(`SELECT id FROM lead_change_requests WHERE lead_id = $1 AND status = 'pending'`, [previous.id]);
  if (pending.rows.length) throw appError('This lead already has a pending change request. Wait for its review.', 409);
  const estimation = await db.query(
    `SELECT estimation_head_id FROM estimation_requests
     WHERE lead_id = $1 AND status NOT IN ('cancelled', 'discarded', 'dropped') ORDER BY id DESC LIMIT 1`,
    [previous.id],
  );
  const estimationHeadId = await chooseReviewer(db, 'estimation_head', reviewers.estimation_head_id, estimation.rows[0]?.estimation_head_id, user.id);
  const result = await db.query(
    `INSERT INTO lead_change_requests
       (lead_id, company_name, requested_by_user_id, requested_by_name, estimation_head_id, before_snapshot, proposed_snapshot, changes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [previous.id, previous.company_name, user.id, user.name, estimationHeadId,
      JSON.stringify(before), JSON.stringify(after), JSON.stringify(changes)],
  );
  const request = result.rows[0];
  await writeActivity(db, previous.id, user, 'approval_requested',
    `Lead change #${request.id} requested; awaiting Estimation Head approval.`,
    { event: 'lead_change_requested', request_id: request.id, changes });
  await notifyUserId(estimationHeadId, {
    title: 'Lead change approval required',
    body: `${user.name} proposed changes to ${previous.company_name}. Your approval is required.`,
    category: 'lead_change', link_type: 'lead_change_request', link_id: request.id,
  }, db);
  return { approval_required: true, change_request: request };
}

async function listLeadChanges(user, db = pool) {
  const roles = ['admin', 'sales_head', 'estimation_head', 'sales_engineer', 'estimation_engineer', 'presales'];
  if (!roles.includes(user.role)) throw appError('You do not have access to lead change requests.', 403);
  const result = await db.query(
    `SELECT r.*, s.first_name || ' ' || s.last_name AS sales_head_name,
       e.first_name || ' ' || e.last_name AS estimation_head_name
     FROM lead_change_requests r
     LEFT JOIN users s ON s.id = r.sales_head_id
     LEFT JOIN users e ON e.id = r.estimation_head_id
     WHERE $1 = 'admin'
       OR ($1 = 'sales_engineer' AND r.requested_by_user_id = $2)
       OR ($1 = 'estimation_head' AND r.estimation_head_id = $2)
       OR ($1 = 'estimation_head' AND r.status = 'applied' AND EXISTS (
         SELECT 1 FROM estimation_requests er WHERE er.lead_id = r.lead_id AND er.estimation_head_id = $2
       ))
       OR ($1 IN ('estimation_engineer', 'presales') AND r.status = 'applied' AND EXISTS (
         SELECT 1 FROM estimation_requests er WHERE er.lead_id = r.lead_id AND er.assigned_engineer_id = $2
       ))
     ORDER BY (r.status = 'pending') DESC, r.created_at DESC, r.id DESC`,
    [user.role, user.id],
  );
  return result.rows;
}

async function reviewLeadChange(id, decision, comments, user, dependencies = {}) {
  if (user.role !== 'estimation_head') throw appError('Only the assigned Estimation Head can review changes.', 403);
  if (!['approve', 'reject'].includes(decision)) throw appError('Invalid review decision.');
  const reason = String(comments || '').trim().slice(0, 2000);
  if (decision === 'reject' && !reason) throw appError('A rejection reason is required.');
  const dbPool = dependencies.pool || pool;
  const applyUpdate = dependencies.updateLead || require('../controller/leads').updateLead;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM lead_change_requests WHERE id = $1 FOR UPDATE', [id]);
    const request = result.rows[0];
    if (!request) throw appError('Lead change request not found.', 404);
    if (String(request.estimation_head_id) !== String(user.id)
      || String(request.requested_by_user_id) === String(user.id)) throw appError('This request is not assigned to you.', 403);
    if (request.status !== 'pending') throw appError('This request has already been resolved.', 409);
    if (request.estimation_approved_at) throw appError('You have already approved this request.', 409);

    if (decision === 'reject') {
      const rejected = await client.query(
        `UPDATE lead_change_requests SET status = 'rejected', rejected_by_user_id = $2, rejection_reason = $3, resolved_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
        [id, user.id, reason],
      );
      await writeActivity(client, request.lead_id, user, 'approval', `Lead change #${id} rejected by ${user.name}: ${reason}`, { event: 'lead_change_rejected', request_id: request.id, reason });
      await notifyUserId(request.requested_by_user_id, { title: 'Lead change rejected', body: `${request.company_name}: ${reason}`, category: 'lead_change', link_type: 'lead_change_request', link_id: request.id }, client);
      await client.query('COMMIT');
      return rejected.rows[0];
    }

    const approved = await client.query(
      `UPDATE lead_change_requests SET estimation_approved_at = CURRENT_TIMESTAMP, estimation_comments = $2 WHERE id = $1 RETURNING *`,
      [id, reason],
    );
    const next = approved.rows[0];
    await writeActivity(client, request.lead_id, user, 'approval', `Lead change #${id} approved by ${user.name} (Estimation Head).`, { event: 'lead_change_approved', request_id: request.id });
    if (next.estimation_approved_at) {
      const leadResult = await client.query('SELECT * FROM leads WHERE id = $1 FOR UPDATE', [request.lead_id]);
      const lead = leadResult.rows[0];
      const stale = !lead || Object.keys(changesBetween(request.before_snapshot, leadSnapshot(lead))).length > 0;
      if (stale) {
        const conflict = await client.query(`UPDATE lead_change_requests SET status = 'conflict', resolved_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [id]);
        await writeActivity(client, request.lead_id, user, 'system', `Lead change #${id} could not be applied because the lead changed during review. Submit a new request.`, { event: 'lead_change_conflict', request_id: request.id });
        await notifyUserId(request.requested_by_user_id, { title: 'Lead change needs resubmission', body: `${request.company_name} changed during review. Review current values and submit again.`, category: 'lead_change', link_type: 'lead_change_request', link_id: request.id }, client);
        await client.query('COMMIT');
        return conflict.rows[0];
      }
      await applyUpdate(request.lead_id, request.proposed_snapshot,
        { id: request.requested_by_user_id, name: request.requested_by_name, role: 'sales_engineer' },
        { db: client, approvedChangeId: request.id });
      const detail = Object.entries(request.changes).map(([field, change]) => {
        const render = (value) => value === null ? '(empty)' : (typeof value === 'object' ? JSON.stringify(value) : String(value)).slice(0, 180);
        return `${field.replace(/_/g, ' ')}: ${render(change.before)} → ${render(change.after)}`;
      }).join('; ');
      await writeActivity(client, request.lead_id, user, 'system',
        `Lead change #${id} applied after Estimation Head approval. ${detail}`,
        { event: 'lead_change_applied', request_id: request.id, changes: request.changes, requested_by_user_id: request.requested_by_user_id, estimation_head_id: request.estimation_head_id });
      const applied = await client.query(`UPDATE lead_change_requests SET status = 'applied', resolved_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [id]);
      const assignments = await client.query(
        `SELECT assigned_engineer_id, estimation_head_id FROM estimation_requests WHERE lead_id = $1 AND status NOT IN ('cancelled', 'discarded', 'dropped')`,
        [request.lead_id],
      );
      const recipients = new Set([request.estimation_head_id, ...assignments.rows.flatMap((row) => [row.assigned_engineer_id, row.estimation_head_id])].filter(Boolean).map(String));
      const fields = Object.keys(request.changes).map((field) => field.replace(/_/g, ' ')).join(', ');
      for (const recipient of recipients) {
        await notifyUserId(recipient, { title: 'Approved lead changes applied', body: `${request.company_name}: ${fields}. Approved by the Estimation Head.`, category: 'lead', link_type: 'lead_change_request', link_id: request.id, metadata: { changes: request.changes, lead_id: request.lead_id } }, client);
      }
      await notifyUserId(request.requested_by_user_id, { title: 'Your lead changes were approved', body: `The Estimation Head approved your changes to ${request.company_name}. The lead is updated.`, category: 'lead_change', link_type: 'lead_change_request', link_id: request.id }, client);
      await client.query('COMMIT');
      return applied.rows[0];
    }
    await client.query('COMMIT');
    return next;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { LEAD_EDIT_FIELDS, leadSnapshot, changesBetween, submitLeadChange, listLeadChanges, reviewLeadChange };
