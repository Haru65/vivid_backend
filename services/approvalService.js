const pool = require('../config/db_connection');
const { logLeadActivity } = require('../controller/leads');
const { APPROVAL_EMAIL_TYPES, sendApprovalEmail } = require('./approvalEmailService');
const { applyNegotiationToQuotation, getQuotationWithNegotiations, negotiationLabel } = require('./negotiationService');

function appError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function actorName(user) {
  return user?.name || 'Workspace user';
}

function samePerson(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function isRequester(user, approval) {
  return samePerson(approval?.requested_by_name, actorName(user));
}

function isAssignedApprover(user, approval) {
  return samePerson(approval?.approver_name, actorName(user));
}

function canViewApproval(user, approval) {
  return isRequester(user, approval) || isAssignedApprover(user, approval);
}

function ensureApprover(user, approval) {
  if (!isAssignedApprover(user, approval)) {
    throw appError('Only the assigned approval person can approve or reject this request.', 403);
  }
  if (isRequester(user, approval)) {
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
  const params = [actorName(user)];
  const where = 'WHERE LOWER(TRIM(ar.requested_by_name)) = LOWER(TRIM($1)) OR LOWER(TRIM(COALESCE(ar.approver_name, \'\'))) = LOWER(TRIM($1))';
  const result = await pool.query(approvalSelect(where), params);
  return result.rows;
}

async function getApproval(id, user) {
  const result = await pool.query(approvalSelect('WHERE ar.id = $1', ''), [id]);
  const approval = result.rows[0];
  if (!approval) throw appError('Approval request not found.', 404);
  if (!canViewApproval(user, approval)) {
    throw appError('You can view only approval requests assigned to you or requested by you.', 403);
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

function frontendUrl(path) {
  const base = process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:5173';
  return `${base.replace(/\/$/, '')}${path}`;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function marginPercent(orderValue, totalCost) {
  const order = numberOrNull(orderValue);
  const cost = numberOrNull(totalCost);
  if (!order || cost === null) return null;
  return ((order - cost) / order) * 100;
}

function discountPercent(currentValue, proposedValue) {
  const current = numberOrNull(currentValue);
  const proposed = numberOrNull(proposedValue);
  if (!current || proposed === null) return null;
  return ((current - proposed) / current) * 100;
}

function inferApprovalEmailType(approval) {
  const metadata = approval.metadata || {};
  if (metadata.approval_email_type) return metadata.approval_email_type;

  const routeText = [
    approval.approver_role,
    approval.approver_name,
    metadata.approver_title,
    approval.approval_type,
  ].filter(Boolean).join(' ').toLowerCase();

  if (routeText.includes('estimation')) return APPROVAL_EMAIL_TYPES.ESTIMATION_HOD;
  if (routeText.includes('sales')) return APPROVAL_EMAIL_TYPES.SALES_HOD;
  return APPROVAL_EMAIL_TYPES.MANAGEMENT;
}

async function findApproverEmail(client, approval) {
  const metadata = approval.metadata || {};
  if (metadata.approver_email) return metadata.approver_email;

  const name = String(approval.approver_name || '').trim();
  if (!name) return null;

  const result = await client.query(
    `SELECT email
     FROM users
     WHERE is_active = TRUE
       AND LOWER(TRIM(CONCAT_WS(' ', first_name, last_name))) = LOWER($1)
     ORDER BY id ASC
     LIMIT 1`,
    [name],
  );

  return result.rows[0]?.email || null;
}

function approvalEmailData(approval) {
  const metadata = approval.metadata || {};
  const lastPitch = metadata.last_pitch || {};
  const orderValue = metadata.current_total || lastPitch.total_amount || approval.total_amount;
  const totalCost = metadata.total_cost || metadata.cost_total || metadata.material_cost || approval.subtotal;
  const proposedValue = approval.proposed_value;

  return {
    quotationNumber: approval.quotation_number,
    customerName: approval.company_name,
    currentValue: approval.old_value || orderValue,
    proposedValue,
    discountPercent: metadata.discount_percent || lastPitch.discount_percent || discountPercent(approval.old_value || orderValue, proposedValue),
    reason: metadata.client_pitch || approval.negotiation_reason || approval.reason,
    approvalUrl: frontendUrl(`/approvals/${approval.id}`),
    materialCost: metadata.material_cost,
    labourCost: metadata.labour_cost,
    totalCost,
    sellingPrice: metadata.selling_price || proposedValue || orderValue,
    marginPercent: metadata.margin_percent || marginPercent(metadata.selling_price || proposedValue || orderValue, totalCost),
    orderValue: proposedValue || orderValue,
    paymentTerms: metadata.payment_terms || lastPitch.payment_terms,
    deliveryTerms: metadata.delivery_terms || (lastPitch.delivery_days ? `${lastPitch.delivery_days} days` : null),
  };
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
    if (!canViewApproval(user, approval)) {
      throw appError('Only the requester or assigned approval person can prepare this approval email.', 403);
    }

    const approverEmail = await findApproverEmail(client, approval);
    if (!approverEmail) {
      throw appError('Approver email could not be found. Add the approver as an active user or provide approver_email in approval metadata.', 400);
    }

    const emailType = inferApprovalEmailType(approval);
    const emailResult = await sendApprovalEmail(
      emailType,
      {
        name: approval.approver_name || approval.approver_role || 'Approver',
        email: approverEmail,
      },
      approvalEmailData(approval),
    );

    const metadata = {
      ...(approval.metadata || {}),
      email_status: 'sent',
      email_type: emailType,
      email_to: approverEmail,
      email_provider_id: emailResult?.id,
      email_subject: emailResult.subject,
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

    await logLeadActivity(approval.lead_id, {
      activity_type: 'email',
      content: `GA approval email sent to ${approval.approver_name || approverEmail} for approval request #${approval.id}.`,
      metadata: {
        negotiation_id: approval.negotiation_id,
        approval_request_id: approval.id,
        quotation_id: approval.quotation_id,
        email_status: 'sent',
        email_subject: emailResult.subject,
        email_to: approverEmail,
      },
    }, user, client);

    await client.query('COMMIT');
    return {
      approval: await getApproval(id, user),
      email: {
        id: emailResult?.id,
        to: approverEmail,
        subject: emailResult.subject,
      },
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
