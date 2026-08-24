const pool = require('../config/db_connection');
const { logLeadActivity } = require('../controller/leads');
const { applyNegotiationToQuotation, getQuotationWithNegotiations, negotiationLabel } = require('./negotiationService');

function appError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function actorName(user) {
  return user?.name || 'Workspace user';
}

function ensureApprover(user, approval) {
  if (user?.role !== 'admin') throw appError('Only GA/admin users can approve or reject requests.', 403);
  if (approval && approval.requested_by_name === actorName(user)) {
    throw appError('Users cannot approve their own GA approval requests.', 403);
  }
}

function approvalSelect(whereClause = '', orderClause = 'ORDER BY ar.requested_at DESC, ar.id DESC') {
  return `
    SELECT ar.*,
      n.id AS negotiation_id,
      n.quotation_id,
      n.lead_id,
      n.negotiation_type,
      n.old_value,
      n.proposed_value,
      n.reason AS negotiation_reason,
      n.status AS negotiation_status,
      q.quotation_number,
      q.company_name,
      q.total_amount,
      q.subtotal,
      q.gst_rate
    FROM approval_requests ar
    JOIN negotiations n ON n.id = ar.record_id AND ar.module = 'negotiation'
    JOIN quotations q ON q.id = n.quotation_id
    ${whereClause}
    ${orderClause}
  `;
}

async function listApprovals(user) {
  const params = [];
  let where = '';
  if (user?.role !== 'admin') {
    params.push(actorName(user));
    where = 'WHERE ar.requested_by_name = $1';
  }
  const result = await pool.query(approvalSelect(where), params);
  return result.rows;
}

async function getApproval(id, user) {
  const result = await pool.query(approvalSelect('WHERE ar.id = $1', ''), [id]);
  const approval = result.rows[0];
  if (!approval) throw appError('Approval request not found.', 404);
  if (user?.role !== 'admin' && approval.requested_by_name !== actorName(user)) {
    throw appError('You can view only your own approval requests.', 403);
  }
  return approval;
}

function normalizeComments(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw appError('Comments must be text.');
  const comments = value.trim();
  if (comments.length > 5000) throw appError('Comments are too long.');
  return comments || null;
}

async function approveRequest(id, data, user) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const approvalResult = await client.query(
      `SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const approval = approvalResult.rows[0];
    if (!approval) throw appError('Approval request not found.', 404);
    ensureApprover(user, approval);
    if (approval.status !== 'pending') throw appError(`Approval request is already ${approval.status}.`, 409);

    const negotiationResult = await client.query(
      `SELECT * FROM negotiations WHERE id = $1 FOR UPDATE`,
      [approval.record_id],
    );
    const negotiation = negotiationResult.rows[0];
    if (!negotiation) throw appError('Negotiation not found for approval request.', 404);
    if (negotiation.status !== 'pending_approval') throw appError(`Negotiation is already ${negotiation.status}.`, 409);

    const quotationResult = await client.query(
      `SELECT * FROM quotations WHERE id = $1 FOR UPDATE`,
      [negotiation.quotation_id],
    );
    const quotation = quotationResult.rows[0];
    if (!quotation) throw appError('Quotation not found.', 404);

    const updatedQuotation = await applyNegotiationToQuotation(client, quotation, negotiation);
    const comments = normalizeComments(data?.comments);
    await client.query(
      `UPDATE approval_requests
       SET status = 'approved',
           approver_name = $1,
           comments = $2,
           approved_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [actorName(user), comments, approval.id],
    );
    await client.query(
      `UPDATE negotiations
       SET status = 'applied',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [negotiation.id],
    );

    const metadata = {
      negotiation_id: negotiation.id,
      approval_request_id: approval.id,
      quotation_id: quotation.id,
      negotiation_type: negotiation.negotiation_type,
      old_value: negotiation.old_value,
      proposed_value: negotiation.proposed_value,
    };
    await logLeadActivity(negotiation.lead_id, {
      activity_type: 'approval',
      content: `GA approved the requested ${negotiation.proposed_value} ${negotiationLabel(negotiation.negotiation_type)}.`,
      metadata,
    }, user, client);
    await logLeadActivity(negotiation.lead_id, {
      activity_type: 'system',
      content: `Quotation ${quotation.quotation_number} updated after approved negotiation.`,
      metadata,
    }, user, client);

    await client.query('COMMIT');
    return {
      approval: await getApproval(id, user),
      quotation: await getQuotationWithNegotiations(pool, updatedQuotation.id),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function rejectRequest(id, data, user) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const approvalResult = await client.query(
      `SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const approval = approvalResult.rows[0];
    if (!approval) throw appError('Approval request not found.', 404);
    ensureApprover(user, approval);
    if (approval.status !== 'pending') throw appError(`Approval request is already ${approval.status}.`, 409);

    const negotiationResult = await client.query(
      `SELECT * FROM negotiations WHERE id = $1 FOR UPDATE`,
      [approval.record_id],
    );
    const negotiation = negotiationResult.rows[0];
    if (!negotiation) throw appError('Negotiation not found for approval request.', 404);

    const comments = normalizeComments(data?.comments);
    await client.query(
      `UPDATE approval_requests
       SET status = 'rejected',
           approver_name = $1,
           comments = $2,
           rejected_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [actorName(user), comments, approval.id],
    );
    await client.query(
      `UPDATE negotiations
       SET status = 'rejected',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [negotiation.id],
    );
    await logLeadActivity(negotiation.lead_id, {
      activity_type: 'approval',
      content: `GA rejected the requested ${negotiation.proposed_value} ${negotiationLabel(negotiation.negotiation_type)}.${comments ? ` Reason: ${comments}` : ''}`,
      metadata: {
        negotiation_id: negotiation.id,
        approval_request_id: approval.id,
        quotation_id: negotiation.quotation_id,
        negotiation_type: negotiation.negotiation_type,
        old_value: negotiation.old_value,
        proposed_value: negotiation.proposed_value,
      },
    }, user, client);

    await client.query('COMMIT');
    return {
      approval: await getApproval(id, user),
      quotation: await getQuotationWithNegotiations(pool, negotiation.quotation_id),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function requestApprovalEmail(id, user) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(approvalSelect('WHERE ar.id = $1', 'FOR UPDATE'), [id]);
    const approval = result.rows[0];
    if (!approval) throw appError('Approval request not found.', 404);
    if (approval.status !== 'pending') throw appError('Only pending approvals can be emailed.', 409);
    if (user?.role !== 'admin' && approval.requested_by_name !== actorName(user)) {
      throw appError('Only the requester or GA/admin can prepare this approval email.', 403);
    }

    const metadata = {
      ...(approval.metadata || {}),
      email_status: 'requested',
      email_requested_at: new Date().toISOString(),
      email_requested_by: actorName(user),
    };
    await client.query(
      `UPDATE approval_requests
       SET metadata = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [JSON.stringify(metadata), approval.id],
    );

    const pitch = approval.metadata || {};
    const lastPitch = pitch.last_pitch || {};
    const subject = `Approval Required - Quotation ${approval.quotation_number}`;
    const body = [
      `To: ${approval.approver_name || approval.approver_role || 'GA/admin'}${pitch.approver_title ? ` (${pitch.approver_title})` : ''}`,
      `Customer: ${approval.company_name}`,
      `Quotation: ${approval.quotation_number}`,
      `Negotiation type: ${negotiationLabel(approval.negotiation_type)}`,
      `Original value: ${approval.old_value || 'Not added'}`,
      `Proposed value: ${approval.proposed_value}`,
      `Last pitch total: ${lastPitch.total_amount || approval.total_amount || 'Not added'}`,
      `Client pitch: ${pitch.client_pitch || approval.negotiation_reason || approval.reason || 'Not provided'}`,
      `Reason: ${approval.negotiation_reason || approval.reason || 'Not provided'}`,
      `Requested by: ${approval.requested_by_name}`,
      `Approval request ID: ${approval.id}`,
    ].join('\n');

    await logLeadActivity(approval.lead_id, {
      activity_type: 'email',
      content: `GA approval email prepared for approval request #${approval.id}.`,
      metadata: {
        negotiation_id: approval.negotiation_id,
        approval_request_id: approval.id,
        quotation_id: approval.quotation_id,
        email_status: 'requested',
        email_subject: subject,
      },
    }, user, client);

    await client.query('COMMIT');
    return {
      approval: await getApproval(id, user),
      email_draft: { subject, body },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  approveRequest,
  getApproval,
  listApprovals,
  rejectRequest,
  requestApprovalEmail,
};
