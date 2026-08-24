const pool = require('../config/db_connection');
const { logLeadActivity } = require('../controller/leads');
const { checkNegotiationApprovalRequirement, extractNumber } = require('./negotiationAuthorityService');

const NEGOTIATION_TYPES = new Set(['discount', 'final_price', 'payment_terms', 'delivery_extension', 'warranty', 'other']);

function appError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function actorName(user) {
  return user?.name || 'Workspace user';
}

function normalizeType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!NEGOTIATION_TYPES.has(type)) throw appError('Negotiation type is invalid.');
  return type;
}

function normalizeReason(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw appError('Reason must be text.');
  const reason = value.trim();
  if (reason.length > 5000) throw appError('Reason is too long.');
  return reason || null;
}

function normalizeText(value, field, maxLength = 255) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw appError(`${field} must be text.`);
  const text = value.trim();
  if (text.length > maxLength) throw appError(`${field} is too long.`);
  return text || null;
}

function normalizeBoolean(value) {
  return value === true || String(value || '').toLowerCase() === 'true';
}

function normalizeProposedValue(type, value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw appError('Proposed value is required.');
  }
  const text = String(value).trim();
  if (text.length > 1000) throw appError('Proposed value is too long.');
  if (['discount', 'final_price', 'delivery_extension'].includes(type)) {
    const number = Number(text);
    if (!Number.isFinite(number) || number < 0) throw appError('Proposed value must be a non-negative number.');
    if (type === 'discount' && number > 100) throw appError('Discount cannot exceed 100%.');
  }
  return text;
}

function currentNegotiationValue(quotation, type) {
  if (type === 'discount') return String(Number(quotation.discount_percent || 0));
  if (type === 'final_price') return String(Number(quotation.final_price || quotation.total_amount || 0));
  if (type === 'payment_terms') return quotation.payment_terms || '';
  if (type === 'delivery_extension') return quotation.delivery_days === null || quotation.delivery_days === undefined ? '' : String(quotation.delivery_days);
  if (type === 'warranty') return quotation.warranty_terms || '';
  return quotation.negotiation_notes || '';
}

function negotiationLabel(type) {
  return type.replace(/_/g, ' ');
}

function money(value) {
  return `INR ${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function recalculateAfterDiscount(quotation, discountPercent) {
  const subtotal = Number(quotation.subtotal || 0);
  const gstRate = Number(quotation.gst_rate || 0);
  const discountAmount = Number((subtotal * discountPercent / 100).toFixed(2));
  const taxableAmount = Math.max(0, subtotal - discountAmount);
  const gstAmount = Number((taxableAmount * gstRate / 100).toFixed(2));
  const totalAmount = Number((taxableAmount + gstAmount).toFixed(2));
  return { discountAmount, gstAmount, totalAmount };
}

async function applyNegotiationToQuotation(client, quotation, negotiation) {
  const type = negotiation.negotiation_type;
  const proposed = negotiation.proposed_value;

  if (type === 'discount') {
    const discountPercent = Number(proposed);
    const totals = recalculateAfterDiscount(quotation, discountPercent);
    const result = await client.query(
      `UPDATE quotations
       SET discount_percent = $1,
           discount_amount = $2,
           final_price = NULL,
           gst_amount = $3,
           total_amount = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING *`,
      [discountPercent, totals.discountAmount, totals.gstAmount, totals.totalAmount, quotation.id],
    );
    return result.rows[0];
  }

  if (type === 'final_price') {
    const finalPrice = Number(proposed);
    const result = await client.query(
      `UPDATE quotations
       SET final_price = $1,
           total_amount = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [finalPrice, quotation.id],
    );
    return result.rows[0];
  }

  if (type === 'payment_terms') {
    const result = await client.query(
      `UPDATE quotations
       SET payment_terms = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [proposed, quotation.id],
    );
    return result.rows[0];
  }

  if (type === 'delivery_extension') {
    const result = await client.query(
      `UPDATE quotations
       SET delivery_days = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [Number(proposed), quotation.id],
    );
    return result.rows[0];
  }

  if (type === 'warranty') {
    const result = await client.query(
      `UPDATE quotations
       SET warranty_terms = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [proposed, quotation.id],
    );
    return result.rows[0];
  }

  const notes = [quotation.negotiation_notes, `Approved other negotiation: ${proposed}`].filter(Boolean).join('\n');
  const result = await client.query(
    `UPDATE quotations
     SET negotiation_notes = $1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2
     RETURNING *`,
    [notes, quotation.id],
  );
  return result.rows[0];
}

async function quotationForAccess(client, quotationId, user, lock = false) {
  const result = await client.query(
    `SELECT q.*, l.assigned_to
     FROM quotations q
     LEFT JOIN leads l ON l.id = q.lead_id
     WHERE q.id = $1
     ${lock ? 'FOR UPDATE OF q' : ''}`,
    [quotationId],
  );
  const quotation = result.rows[0];
  if (!quotation) throw appError('Quotation not found.', 404);
  if (user?.role === 'salesperson' && quotation.assigned_to !== user.name) {
    throw appError('Salespersons can negotiate only their assigned lead quotations.', 403);
  }
  return quotation;
}

async function getQuotationWithNegotiations(client, quotationId) {
  const result = await client.query(
    `SELECT q.*,
       COALESCE((
         SELECT json_agg(json_build_object(
           'id', n.id,
           'lead_id', n.lead_id,
           'quotation_id', n.quotation_id,
           'negotiation_type', n.negotiation_type,
           'old_value', n.old_value,
           'proposed_value', n.proposed_value,
           'reason', n.reason,
           'requested_by_name', n.requested_by_name,
           'requested_by_role', n.requested_by_role,
           'requires_approval', n.requires_approval,
           'approval_request_id', n.approval_request_id,
           'status', n.status,
           'created_at', n.created_at,
           'updated_at', n.updated_at
         ) ORDER BY n.created_at DESC, n.id DESC)
         FROM negotiations n
         WHERE n.quotation_id = q.id
       ), '[]'::json) AS negotiations
     FROM quotations q
     WHERE q.id = $1`,
    [quotationId],
  );
  return result.rows[0] || null;
}

async function checkNegotiation(quotationId, data, user) {
  const client = await pool.connect();
  try {
    const type = normalizeType(data.negotiation_type);
    const proposedValue = normalizeProposedValue(type, data.proposed_value);
    const quotation = await quotationForAccess(client, quotationId, user);
    const authority = await checkNegotiationApprovalRequirement({
      client,
      user,
      negotiationType: type,
      proposedValue,
      quotation,
    });
    return {
      approval_required: authority.approvalRequired,
      authority_limit: authority.authorityLimit,
      comparison_value: authority.comparisonValue,
      message: authority.approvalRequired ? authority.reason : 'Within your negotiation authority. No GA approval required.',
    };
  } finally {
    client.release();
  }
}

async function createNegotiation(quotationId, data, user) {
  const client = await pool.connect();
  try {
    const type = normalizeType(data.negotiation_type);
    const proposedValue = normalizeProposedValue(type, data.proposed_value);
    const clientPitch = normalizeReason(data.client_pitch);
    const reason = normalizeReason(data.reason) || clientPitch;
    const forcedApproval = normalizeBoolean(data.force_approval);
    const approverName = normalizeText(data.approver_name, 'Approver name');
    const approverRole = normalizeText(data.approver_role, 'Approver role', 100) || 'admin';
    const approverTitle = normalizeText(data.approver_title, 'Approver title', 100);

    await client.query('BEGIN');
    const quotation = await quotationForAccess(client, quotationId, user, true);
    const oldValue = currentNegotiationValue(quotation, type);
    const authority = await checkNegotiationApprovalRequirement({
      client,
      user,
      negotiationType: type,
      proposedValue,
      quotation,
    });
    const approvalRequired = authority.approvalRequired || forcedApproval;
    if (approvalRequired && !approverName) {
      throw appError('Choose the higher-up for this GA approval request.');
    }
    const approvalReason = authority.approvalRequired
      ? authority.reason
      : 'Sales requested higher-up approval for this negotiation.';

    const negotiationResult = await client.query(
      `INSERT INTO negotiations (
        lead_id,
        quotation_id,
        negotiation_type,
        old_value,
        proposed_value,
        reason,
        requested_by_name,
        requested_by_role,
        requires_approval,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        quotation.lead_id,
        quotation.id,
        type,
        oldValue,
        proposedValue,
        reason,
        actorName(user),
        user?.role || null,
        approvalRequired,
        approvalRequired ? 'pending_approval' : 'open',
      ],
    );
    let negotiation = negotiationResult.rows[0];
    let approvalRequest = null;
    let updatedQuotation = quotation;

    const metadata = {
      negotiation_id: negotiation.id,
      quotation_id: quotation.id,
      negotiation_type: type,
      old_value: oldValue,
      proposed_value: proposedValue,
      authority_limit: authority.authorityLimit,
      force_approval: forcedApproval,
      approver_name: approverName,
      approver_role: approverRole,
      approver_title: approverTitle,
      client_pitch: clientPitch,
      last_pitch: {
        quotation_number: quotation.quotation_number,
        total_amount: quotation.total_amount,
        discount_percent: quotation.discount_percent,
        final_price: quotation.final_price,
        payment_terms: quotation.payment_terms,
        delivery_days: quotation.delivery_days,
        warranty_terms: quotation.warranty_terms,
        sent_at: quotation.sent_at,
      },
    };

    await logLeadActivity(quotation.lead_id, {
      activity_type: 'negotiation',
      content: `Customer requested ${proposedValue} ${negotiationLabel(type)} on quotation ${quotation.quotation_number}.`,
      metadata,
    }, user, client);

    if (approvalRequired) {
      const approvalResult = await client.query(
        `INSERT INTO approval_requests (
          module,
          record_id,
          approval_type,
          requested_by_name,
          requested_by_role,
          approver_name,
          approver_role,
          status,
          reason,
          metadata
        ) VALUES ('negotiation', $1, 'ga_negotiation', $2, $3, $4, $5, 'pending', $6, $7)
        RETURNING *`,
        [
          negotiation.id,
          actorName(user),
          user?.role || null,
          approverName,
          approverRole || authority.approverRole,
          approvalReason,
          JSON.stringify({
            ...metadata,
            email_status: 'not_requested',
            customer: quotation.company_name,
            quotation_number: quotation.quotation_number,
            requested_reason: reason,
            client_pitch: clientPitch,
            current_total: quotation.total_amount,
            comparison_value: authority.comparisonValue,
            authority_message: authority.reason,
          }),
        ],
      );
      approvalRequest = approvalResult.rows[0];
      const linked = await client.query(
        `UPDATE negotiations
         SET approval_request_id = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING *`,
        [approvalRequest.id, negotiation.id],
      );
      negotiation = linked.rows[0];

      await logLeadActivity(quotation.lead_id, {
        activity_type: 'approval_requested',
        content: `GA approval requested from ${approverName} for ${proposedValue} ${negotiationLabel(type)}. ${approvalReason}`,
        metadata: { ...metadata, approval_request_id: approvalRequest.id },
      }, user, client);
    } else {
      updatedQuotation = await applyNegotiationToQuotation(client, quotation, negotiation);
      const applied = await client.query(
        `UPDATE negotiations
         SET status = 'applied',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [negotiation.id],
      );
      negotiation = applied.rows[0];
      await logLeadActivity(quotation.lead_id, {
        activity_type: 'negotiation',
        content: `${proposedValue} ${negotiationLabel(type)} applied to quotation ${quotation.quotation_number}.`,
        metadata,
      }, user, client);
      await logLeadActivity(quotation.lead_id, {
        activity_type: 'system',
        content: `Quotation ${quotation.quotation_number} updated after approved negotiation.`,
        metadata,
      }, user, client);
    }

    await client.query('COMMIT');
    const responseQuotation = await getQuotationWithNegotiations(pool, updatedQuotation.id);

    return {
      success: true,
      message: approvalRequired ? 'GA approval required' : 'Negotiation applied',
      approval_required: approvalRequired,
      authority,
      negotiation,
      approval_request: approvalRequest,
      quotation: responseQuotation,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  NEGOTIATION_TYPES,
  applyNegotiationToQuotation,
  checkNegotiation,
  createNegotiation,
  getQuotationWithNegotiations,
  negotiationLabel,
  money,
  extractNumber,
};
