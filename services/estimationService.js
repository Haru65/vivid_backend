
const pool = require('../config/db_connection');
const { createQuotation, createQuotationRevision, updateQuotation } = require('../controller/quotations');
const { logLeadActivity } = require('../controller/leads');
const { createNotification, notifyRole, notifyUserId } = require('./notificationService');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const HEAD_ROLES = new Set(['admin', 'sales_head', 'estimation_head']);
const SALES_ROLES = new Set(['admin', 'sales_head', 'sales_engineer', 'salesperson']);
const ESTIMATION_ROLES = new Set(['admin', 'estimation_head', 'estimation_engineer']);

function appError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function actorName(user) {
  return user?.name || 'Workspace user';
}

function isSalesHead(user) {
  return ['admin', 'sales_head'].includes(user?.role);
}

function isEstimationHead(user) {
  return ['admin', 'estimation_head'].includes(user?.role);
}

function requireSales(user) {
  if (!SALES_ROLES.has(user?.role)) throw appError('Only sales users can submit enquiries to estimation.', 403);
}

function requireEstimation(user) {
  if (!ESTIMATION_ROLES.has(user?.role)) throw appError('Only estimation users can work on estimation requests.', 403);
}

function requireEstimationHead(user) {
  if (!isEstimationHead(user)) throw appError('Only estimation head can assign or approve estimation work.', 403);
}

function text(value, field, maxLength, required = false) {
  const result = String(value || '').trim();
  if (!result) {
    if (required) throw appError(`${field} is required.`);
    return null;
  }
  if (result.length > maxLength) throw appError(`${field} is too long.`);
  return result;
}

function initialsFromText(value, fallback = 'VIVID') {
  const words = String(value || '').replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 4);
  const initials = words.map((word) => word[0]).join('').toUpperCase();
  return initials || fallback;
}

function productCode(value) {
  const first = String(value || '').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)[0];
  return (first || 'PROJECT').slice(0, 8).toUpperCase();
}

function autoPoNumber(request) {
  const sourceDate = request.updated_at || request.submitted_at || new Date();
  const year = new Date(sourceDate).getFullYear();
  const serial = String(request.id || request.lead_id || 1).padStart(3, '0');
  return `${initialsFromText(request.company_name)}/PO/${productCode(request.enquiry_product)}/${year}/${serial}`;
}

const SELECT_REQUEST = `
  er.*,
  l.company_name,
  l.contact_person_name,
  l.contact_person_email,
  l.contact_person_phone,
  l.lead_status,
  q.quotation_number,
  q.status AS quotation_status,
  q.total_amount AS quotation_total,
  q.created_at AS quotation_created_at,
  pcs.sales_data AS po_sales_data,
  pcs.estimation_data AS po_estimation_data,
  pcs.status AS po_sheet_status,
  pcs.sales_submitted_at AS po_sales_submitted_at,
  pcs.estimation_filled_at AS po_estimation_filled_at,
  pcs.head_approved_at AS po_head_approved_at
`;

function requestQuery(where = '', order = 'ORDER BY er.updated_at DESC, er.id DESC') {
  return `
    SELECT ${SELECT_REQUEST}
    FROM estimation_requests er
    JOIN leads l ON l.id = er.lead_id
    LEFT JOIN quotations q ON q.id = er.quotation_id
    LEFT JOIN po_closure_sheets pcs ON pcs.id = er.po_closure_sheet_id
    ${where}
    ${order}
  `;
}

function canViewRequest(user, request) {
  if (['admin', 'estimation_head', 'sales_head'].includes(user?.role)) return true;
  if (user?.role === 'estimation_engineer') return String(request.assigned_engineer_id || '') === String(user.id || '');
  if (['sales_engineer', 'salesperson'].includes(user?.role)) {
    return request.sales_owner_name === user.name || request.requested_by_name === user.name || String(request.sales_owner_id || '') === String(user.id || '');
  }
  return false;
}

async function getRequest(id, user, client = pool) {
  const result = await client.query(requestQuery('WHERE er.id = $1'), [id]);
  const request = result.rows[0];
  if (!request) throw appError('Estimation request not found.', 404);
  if (!canViewRequest(user, request)) throw appError('You cannot view this estimation request.', 403);
  return request;
}

async function listEstimationRequests(user) {
  let result;
  if (['admin', 'sales_head', 'estimation_head'].includes(user?.role)) {
    result = await pool.query(requestQuery());
  } else if (user?.role === 'estimation_engineer') {
    result = await pool.query(requestQuery('WHERE er.assigned_engineer_id = $1'), [user.id]);
  } else {
    result = await pool.query(requestQuery('WHERE er.requested_by_name = $1 OR er.sales_owner_name = $1 OR er.sales_owner_id = $2'), [actorName(user), user?.id || null]);
  }
  return result.rows;
}

async function submitLeadToEstimation(leadId, user) {
  requireSales(user);
  const client = await pool.connect();
  let request;
  try {
    await client.query('BEGIN');
    const leadResult = await client.query(
      `SELECT id, customer_id, company_name, assigned_to, NULLIF(to_jsonb(leads)->>'sales_owner_id', '')::BIGINT AS sales_owner_id, segment, site_location,
              consultant, enquiry_product, enquiry_notes, requirements_summary
       FROM leads
       WHERE id = $1
       FOR UPDATE`,
      [leadId],
    );
    const lead = leadResult.rows[0];
    if (!lead) throw appError('Lead not found.', 404);
    if (['salesperson', 'sales_engineer'].includes(user?.role)
      && String(lead.sales_owner_id || '') !== String(user?.id || '')
      && lead.assigned_to !== actorName(user)) {
      throw appError('You can submit only leads assigned to you.', 403);

    }
    const existing = await client.query(
      `SELECT id FROM estimation_requests
       WHERE lead_id = $1 AND status NOT IN ('cancelled', 'discarded')
       LIMIT 1`,
      [lead.id],
    );
    if (existing.rows[0]) throw appError('This lead is already in estimation workflow.', 409);

    const head = await client.query(
      `SELECT id, first_name, last_name FROM users
       WHERE is_active = TRUE AND role = 'estimation_head'
       ORDER BY id ASC LIMIT 1`,
    );
    const estimationHead = head.rows[0] || null;
    const headName = estimationHead ? [estimationHead.first_name, estimationHead.last_name].filter(Boolean).join(' ') : null;

    const insert = await client.query(
      `INSERT INTO estimation_requests (
        lead_id, customer_id, requested_by_user_id, requested_by_name, sales_owner_id, sales_owner_name,
        estimation_head_id, estimation_head_name, status, segment, site_location, consultant,
        enquiry_product, enquiry_notes, requirements_summary
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'submitted', $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [
        lead.id,
        lead.customer_id || null,
        user?.id || null,
        actorName(user),
        lead.sales_owner_id || (['salesperson', 'sales_engineer'].includes(user?.role) ? user?.id : null),
        lead.assigned_to || actorName(user),
        estimationHead?.id || null,
        headName,
        lead.segment || null,
        lead.site_location || null,
        lead.consultant || null,
        lead.enquiry_product || null,
        lead.enquiry_notes || null,
        lead.requirements_summary || null,
      ],
    );
    request = insert.rows[0];

    await client.query(
      `UPDATE leads SET lead_status = 'Qualified' WHERE id = $1`,
      [lead.id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await logLeadActivity(leadId, {
    activity_type: 'system',
    content: `Enquiry submitted to estimation${request.estimation_head_name ? ` head ${request.estimation_head_name}` : ''}`,
  }, user);
  const notification = {
    title: 'New enquiry for estimation',
    body: `${request.sales_owner_name || request.requested_by_name} submitted ${request.enquiry_product || 'an enquiry'} for ${request.company_name || `lead #${leadId}`}.`,
    category: 'estimation',
    link_type: 'estimation_request',
    link_id: request.id,
  };
  if (request.estimation_head_id) await notifyUserId(request.estimation_head_id, notification);
  else await notifyRole('estimation_head', notification);
  return getRequest(request.id, user);
}

async function assignRequest(id, data, user) {
  requireEstimationHead(user);
  const engineerId = Number(data.engineer_id);
  if (!Number.isInteger(engineerId) || engineerId <= 0) throw appError('Estimation engineer is required.');
  const notes = text(data.assignment_notes, 'Assignment notes', 2000);
  const client = await pool.connect();
  let request;
  let engineerName;
  try {
    await client.query('BEGIN');
    request = await getRequest(id, user, client);
    if (!['submitted', 'assigned', 'revision_requested'].includes(request.status)) {
      throw appError('Only submitted or revision-requested estimation work can be assigned.');
    }
    const engineer = await client.query(
      `SELECT id, first_name, last_name FROM users
       WHERE id = $1 AND is_active = TRUE AND role = 'estimation_engineer'`,
      [engineerId],
    );
    if (!engineer.rows[0]) throw appError('Select an active estimation engineer.', 404);
    engineerName = [engineer.rows[0].first_name, engineer.rows[0].last_name].filter(Boolean).join(' ');
    const updated = await client.query(
      `UPDATE estimation_requests
       SET assigned_engineer_id = $1,
           assigned_engineer_name = $2,
           estimation_head_id = COALESCE(estimation_head_id, $3),
           estimation_head_name = COALESCE(estimation_head_name, $4),
           assignment_notes = $5,
           status = 'assigned',
           assigned_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING *`,
      [engineerId, engineerName, user?.id || null, actorName(user), notes, id],
    );
    request = updated.rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await logLeadActivity(request.lead_id, {
    activity_type: 'system',
    content: `Estimation assigned to ${engineerName}`,
  }, user);
  await notifyUserId(engineerId, {
    title: 'Estimation request assigned',
    body: `${actorName(user)} assigned ${request.enquiry_product || 'an enquiry'} for ${request.company_name || `lead #${request.lead_id}`} to you.`,
    category: 'estimation',
    link_type: 'estimation_request',
    link_id: request.id,
  });
  return getRequest(id, user);
}

async function createOrUpdateRequestQuotation(id, data, user) {
  requireEstimation(user);
  const request = await getRequest(id, user);
  if (user.role === 'estimation_engineer' && String(request.assigned_engineer_id || '') !== String(user.id || '')) {
    throw appError('Only the assigned estimation engineer can prepare this quotation.', 403);
  }
  if (!['assigned', 'in_progress', 'revision_requested', 'revision_requested_by_sales', 'revision_in_progress'].includes(request.status)) {
    throw appError('This estimation request is not ready for quotation preparation.');
  }

  const payload = { ...data, lead_id: request.lead_id };
  let quotation;
  if (request.quotation_id) {
    quotation = await updateQuotation(request.quotation_id, payload, user);
    if (!quotation) throw appError('Existing draft quotation is not editable.', 409);
  } else {
    quotation = await createQuotation(payload, user);
  }

  const updated = await pool.query(
    `UPDATE estimation_requests
     SET quotation_id = $1,
         assigned_engineer_id = COALESCE(assigned_engineer_id, $2),
         assigned_engineer_name = COALESCE(assigned_engineer_name, $3),
         status = CASE WHEN status IN ('revision_requested_by_sales', 'revision_in_progress') THEN 'revision_in_progress' ELSE 'in_progress' END,
         engineer_started_at = COALESCE(engineer_started_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $4
     RETURNING *`,
    [quotation.id, user?.id || null, actorName(user), id],
  );
  await pool.query(
    `UPDATE quotations
     SET estimation_request_id = $1,
         prepared_by_user_id = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [id, user?.id || null, quotation.id],
  );
  await logLeadActivity(request.lead_id, {
    activity_type: 'system',
    content: `Estimation quotation ${quotation.quotation_number} prepared by ${actorName(user)}`,
  }, user);
  return getRequest(updated.rows[0].id, user);
}

async function submitForReview(id, user) {
  requireEstimation(user);
  const request = await getRequest(id, user);
  if (!request.quotation_id) throw appError('Create a quotation before submitting for review.');
  if (user.role === 'estimation_engineer' && String(request.assigned_engineer_id || '') !== String(user.id || '')) {
    throw appError('Only the assigned estimation engineer can submit this request.', 403);
  }
  await pool.query(
    `UPDATE estimation_requests
     SET status = 'returned_to_sales',
         engineer_submitted_at = CURRENT_TIMESTAMP,
         returned_to_sales_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id],
  );
  await logLeadActivity(request.lead_id, {
    activity_type: 'system',
    content: `Quotation sent to sales by estimation engineer`,
  }, user);
  const salesNotification = {
    title: 'Quotation ready to send',
    body: `${actorName(user)} sent quotation ${request.quotation_number || ''} back to sales for ${request.company_name || `lead #${request.lead_id}`}.`,
    category: 'quotation',
    link_type: 'quotation',
    link_id: request.quotation_id,
  };
  if (request.sales_owner_id) await notifyUserId(request.sales_owner_id, salesNotification);
  else await createNotification({ name: request.sales_owner_name || request.requested_by_name }, salesNotification);
  const headNotification = {
    title: 'Quotation sent to sales',
    body: `${actorName(user)} sent quotation ${request.quotation_number || ''} to sales.`,
    category: 'estimation',
    link_type: 'estimation_request',
    link_id: request.id,
  };
  if (request.estimation_head_id) await notifyUserId(request.estimation_head_id, headNotification);
  else await notifyRole('estimation_head', headNotification);
  return getRequest(id, user);
}

async function requestRevision(id, data, user) {
  requireEstimationHead(user);
  const request = await getRequest(id, user);
  const notes = text(data.notes || data.revision_notes, 'Revision notes', 2000, true);
  await pool.query(
    `UPDATE estimation_requests
     SET status = 'revision_requested',
         revision_notes = $1,
         review_notes = $1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [notes, id],
  );
  await logLeadActivity(request.lead_id, {
    activity_type: 'system',
    content: `Estimation head requested revision: ${notes}`,
  }, user);
  if (request.assigned_engineer_id) await notifyUserId(request.assigned_engineer_id, {
    title: 'Quotation revision requested',
    body: notes,
    category: 'estimation',
    link_type: 'estimation_request',
    link_id: request.id,
  });
  return getRequest(id, user);
}

async function approveRequest(id, data, user) {
  requireEstimationHead(user);
  const request = await getRequest(id, user);
  if (!request.quotation_id) throw appError('Quotation is required before approval.');
  if (!['submitted_for_review', 'revision_submitted_for_review', 'in_progress', 'revision_in_progress'].includes(request.status)) {
    throw appError('Only submitted estimation quotations can be approved.');
  }
  const notes = text(data.notes || data.review_notes, 'Review notes', 2000);
  await pool.query(
    `UPDATE estimation_requests
     SET status = 'returned_to_sales',
         review_notes = $1,
         estimation_head_id = COALESCE(estimation_head_id, $2),
         estimation_head_name = COALESCE(estimation_head_name, $3),
         head_approved_at = CURRENT_TIMESTAMP,
         returned_to_sales_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $4`,
    [notes, user?.id || null, actorName(user), id],
  );
  await pool.query(
    `UPDATE quotations
     SET reviewed_by_user_id = $1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [user?.id || null, request.quotation_id],
  );
  await logLeadActivity(request.lead_id, {
    activity_type: 'system',
    content: `Estimation approved quotation ${request.quotation_number || ''} and returned it to sales`,
  }, user);
  if (request.sales_owner_id) await notifyUserId(request.sales_owner_id, {
    title: 'Quotation returned to sales',
    body: `Estimation approved ${request.quotation_number || 'the quotation'} for ${request.company_name || `lead #${request.lead_id}`}.`,
    category: 'quotation',
    link_type: 'quotation',
    link_id: request.quotation_id,
  });
  else await createNotification({ name: request.sales_owner_name || request.requested_by_name }, {
    title: 'Quotation returned to sales',
    body: `Estimation approved ${request.quotation_number || 'the quotation'} for ${request.company_name || `lead #${request.lead_id}`}.`,
    category: 'quotation',
    link_type: 'quotation',
    link_id: request.quotation_id,
  });
  return getRequest(id, user);
}

async function markQuotationSent(quotationId, user, db = pool) {
  const result = await db.query(
    `UPDATE estimation_requests
     SET status = 'sent_to_client',
         sent_to_client_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE quotation_id = $1
       AND status = 'returned_to_sales'
     RETURNING *`,
    [quotationId],
  );
  const request = result.rows[0] || null;
  if (request) {
    await db.query(
      `UPDATE quotations
       SET sent_by_user_id = $1
       WHERE id = $2`,
      [user?.id || null, quotationId],
    );
  }
  return request;
}


function jsonObject(value, field) {
  if (!value) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw appError(`${field} must be an object.`);
  return value;
}

async function requestSalesRevision(id, data, user) {
  requireSales(user);
  const request = await getRequest(id, user);
  if (!['sent_to_client', 'returned_to_sales'].includes(request.status)) throw appError('Only sent or returned quotations can be sent back for revision.');
  const notes = text(data.notes || data.revision_notes, 'Revision notes', 2000, true);
  let revision = null;
  if (request.status === 'sent_to_client' && request.quotation_id) {
    revision = await createQuotationRevision(request.quotation_id, {
      revision_reason: notes,
      negotiation_notes: notes,
    }, user);
  }
  await pool.query(
    `UPDATE estimation_requests
     SET status = 'revision_requested_by_sales',
         revision_requested_by = 'sales',
         revision_notes = $1,
         quotation_id = COALESCE($3, quotation_id),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [notes, id, revision?.id || null],
  );
  await logLeadActivity(request.lead_id, {
    activity_type: 'system',
    content: revision
      ? `Sales requested revision ${revision.quotation_number}: ${notes}`
      : `Sales requested estimation revision: ${notes}`,
  }, user);
  if (request.assigned_engineer_id) await notifyUserId(request.assigned_engineer_id, {
    title: revision ? `Sales created ${revision.quotation_number}` : 'Sales requested quotation revision',
    body: notes,
    category: 'estimation',
    link_type: 'estimation_request',
    link_id: request.id,
  });
  if (request.estimation_head_id) await notifyUserId(request.estimation_head_id, {
    title: revision ? `Revision ${revision.quotation_number} sent to estimation` : 'Sales sent quotation back for revision',
    body: notes,
    category: 'estimation',
    link_type: 'estimation_request',
    link_id: request.id,
  });
  return getRequest(id, user);
}

async function markClientApproved(id, data, user) {
  requireSales(user);
  const request = await getRequest(id, user);
  if (!['sent_to_client', 'returned_to_sales'].includes(request.status)) throw appError('Quotation must be sent/ready before client approval.');
  const poNumber = text(data.po_number, 'PO number', 100);
  await pool.query(
    `UPDATE estimation_requests
     SET status = 'client_approved', client_decision = 'approved', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`, [id],
  );
  if (request.quotation_id) {
    await pool.query(
      `UPDATE quotations SET customer_po_number = COALESCE($1, customer_po_number), order_confirmed_at = COALESCE(order_confirmed_at, CURRENT_TIMESTAMP) WHERE id = $2`,
      [poNumber, request.quotation_id],
    );
  }
  await logLeadActivity(request.lead_id, { activity_type: 'system', content: `Client approved quotation${poNumber ? ` with PO ${poNumber}` : ''}` }, user);
  return getRequest(id, user);
}

async function discardRequest(id, data, user) {
  requireSales(user);
  const request = await getRequest(id, user);
  const reason = text(data.reason, 'Discard reason', 2000, true);
  await pool.query(
    `UPDATE estimation_requests SET status = 'discarded', client_decision = 'discarded', discard_reason = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [reason, id],
  );
  await pool.query(`UPDATE leads SET lead_status = 'Lost' WHERE id = $1`, [request.lead_id]);
  await logLeadActivity(request.lead_id, { activity_type: 'system', content: `Opportunity discarded: ${reason}` }, user);
  return getRequest(id, user);
}

async function upsertPoSheet(id, user, salesData = {}) {
  requireSales(user);
  const request = await getRequest(id, user);
  if (!['sent_to_client', 'client_approved'].includes(request.status)) {
    throw appError('PO can be generated only after the quotation is sent to the client.');
  }
  if (!request.quotation_id) throw appError('Quotation is required before PO generation.');
  const data = jsonObject(salesData, 'PO sales data');
  const poNumber = text(data.po_number || data.po_ref || autoPoNumber(request), 'PO number', 100, true);
  data.po_number = poNumber;
  data.po_date = data.po_date || new Date().toISOString().slice(0, 10);
  const client = await pool.connect();
  let sheet;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO po_closure_sheets (
         estimation_request_id, lead_id, quotation_id, customer_id, status, sales_data,
         sales_submitted_by_user_id, sales_submitted_by_name, sales_submitted_at
       ) VALUES ($1, $2, $3, $4, 'submitted_to_estimation', $5, $6, $7, CURRENT_TIMESTAMP)
       ON CONFLICT (estimation_request_id) DO UPDATE
       SET sales_data = EXCLUDED.sales_data,
           status = 'submitted_to_estimation',
           sales_submitted_by_user_id = EXCLUDED.sales_submitted_by_user_id,
           sales_submitted_by_name = EXCLUDED.sales_submitted_by_name,
           sales_submitted_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [id, request.lead_id, request.quotation_id, request.customer_id, JSON.stringify(data), user?.id || null, actorName(user)],
    );
    sheet = result.rows[0];
    await client.query(
      `UPDATE quotations
       SET customer_po_number = COALESCE($1, customer_po_number),
           order_confirmed_at = COALESCE(order_confirmed_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [poNumber, request.quotation_id],
    );
    await client.query(
      `UPDATE estimation_requests
       SET status = 'po_submitted_to_estimation',
           client_decision = 'approved',
           po_closure_sheet_id = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [sheet.id, id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (request.assigned_engineer_id) await notifyUserId(request.assigned_engineer_id, { title: 'PO sheet submitted', body: `${actorName(user)} submitted PO closure sheet.`, category: 'po', link_type: 'estimation_request', link_id: id });
  await logLeadActivity(request.lead_id, { activity_type: 'system', content: 'PO closure sheet submitted to estimation' }, user);
  return sheet;
}

async function savePoEstimation(id, data, user) {
  requireEstimation(user);
  const request = await getRequest(id, user);
  if (!request.po_closure_sheet_id) throw appError('Sales must submit PO sheet first.');
  if (request.status !== 'po_submitted_to_estimation') throw appError('PO estimation section can be filled only after sales submits the PO sheet.');
  if (user.role === 'estimation_engineer' && String(request.assigned_engineer_id || '') !== String(user.id || '')) {
    throw appError('Only the assigned estimation engineer can fill this PO sheet.', 403);
  }
  const values = jsonObject(data, 'PO estimation data');
  const result = await pool.query(
    `UPDATE po_closure_sheets
     SET estimation_data = $1,
         status = 'submitted_to_head',
         estimation_filled_by_user_id = $2,
         estimation_filled_by_name = $3,
         estimation_filled_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $4 RETURNING *`,
    [JSON.stringify(values), user?.id || null, actorName(user), request.po_closure_sheet_id],
  );
  await pool.query(`UPDATE estimation_requests SET status = 'po_submitted_to_head', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  if (request.estimation_head_id) await notifyUserId(request.estimation_head_id, { title: 'PO sheet ready for approval', body: `${actorName(user)} filled estimation section.`, category: 'po', link_type: 'estimation_request', link_id: id });
  await logLeadActivity(request.lead_id, { activity_type: 'system', content: 'Estimation section filled on PO closure sheet' }, user);
  return result.rows[0];
}

async function approvePoSheet(id, user) {
  requireEstimationHead(user);
  const request = await getRequest(id, user);
  if (!request.po_closure_sheet_id) throw appError('PO sheet not found.');
  if (request.status !== 'po_submitted_to_head') throw appError('PO can be approved only after estimation submits its section.');
  const sheetCheck = await pool.query(`SELECT status, estimation_data FROM po_closure_sheets WHERE id = $1`, [request.po_closure_sheet_id]);
  const sheet = sheetCheck.rows[0];
  if (!sheet || sheet.status !== 'submitted_to_head' || !sheet.estimation_data || !Object.keys(sheet.estimation_data).length) {
    throw appError('Estimation section must be filled before HOD approval.');
  }
  const result = await pool.query(
    `UPDATE po_closure_sheets
     SET status = 'approved_by_estimation_head',
         head_approved_by_user_id = $1,
         head_approved_by_name = $2,
         head_approved_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3 RETURNING *`,
    [user?.id || null, actorName(user), request.po_closure_sheet_id],
  );
  await pool.query(`UPDATE estimation_requests SET status = 'po_approved_by_estimation_head', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
  if (request.sales_owner_id) await notifyUserId(request.sales_owner_id, { title: 'PO sheet approved', body: 'Estimation Head approved the PO closure sheet.', category: 'po', link_type: 'estimation_request', link_id: id });
  await logLeadActivity(request.lead_id, { activity_type: 'system', content: 'PO closure sheet approved by Estimation Head' }, user);
  return result.rows[0];
}

async function getPoSheet(id, user) {
  const request = await getRequest(id, user);
  if (!request.po_closure_sheet_id) throw appError('PO sheet not found.', 404);
  const result = await pool.query(`SELECT * FROM po_closure_sheets WHERE id = $1`, [request.po_closure_sheet_id]);
  return result.rows[0];
}

function pdfText(value, fallback = '') {
  return String(value ?? fallback ?? '')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u20b9/g, 'Rs. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function poDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return pdfText(value, '-');
  return date.toLocaleDateString('en-GB').replace(/\//g, '-');
}

function poAmount(value, fallback = '-') {
  const raw = pdfText(value);
  if (!raw) return fallback;
  if (/^(?:na|n\/a|-|customer scope|vivid scope)$/i.test(raw)) return raw;
  const numeric = Number(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(numeric) ? `Rs. ${numeric.toLocaleString('en-IN')}` : raw;
}

function safePdfFilename(value) {
  return pdfText(value, 'PO').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'PO';
}

async function buildPoFrontSheetPdf(request, sheet) {
  const sales = sheet.sales_data || {};
  const est = sheet.estimation_data || {};
  const pdfDoc = await PDFDocument.create();
  // The approved Neosol front sheet is US Letter portrait (612 x 792 pt).
  const page = pdfDoc.addPage([612, 792]);
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const white = rgb(1, 1, 1);
  const salesFill = rgb(0.94, 0.93, 0.88);
  const salesBand = rgb(0.76, 0.85, 0.95);
  const estimationFill = rgb(0.86, 0.94, 0.96);
  const brandRed = rgb(0.86, 0.10, 0.13);
  const brandGreen = rgb(0.02, 0.48, 0.23);
  const left = 40;
  const tableWidth = 532;
  let cursor = 770;

  const wrap = (value, font, size, maxWidth) => {
    const normalized = pdfText(value);
    if (!normalized) return [];
    const words = normalized.split(' ');
    const lines = [];
    let current = '';
    words.forEach((word) => {
      const candidate = current ? `${current} ${word}` : word;
      if (!current || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    });
    if (current) lines.push(current);
    return lines;
  };

  const cell = (value, x, top, width, height, options = {}) => {
    const {
      fill = white,
      font = regular,
      size = 6,
      align = 'left',
      padding = 2,
      border = true,
    } = options;
    page.drawRectangle({
      x,
      y: top - height,
      width,
      height,
      color: fill,
      borderColor: border ? black : fill,
      borderWidth: border ? 0.35 : 0,
    });
    const availableWidth = Math.max(1, width - (padding * 2));
    const lineHeight = size + 0.7;
    const maxLines = Math.max(1, Math.floor((height - 2) / lineHeight));
    const lines = wrap(value, font, size, availableWidth).slice(0, maxLines);
    if (lines.length === maxLines && wrap(value, font, size, availableWidth).length > maxLines) {
      let last = lines[maxLines - 1];
      while (last && font.widthOfTextAtSize(`${last}...`, size) > availableWidth) last = last.slice(0, -1);
      lines[maxLines - 1] = `${last}...`;
    }
    const blockHeight = lines.length * lineHeight;
    let textY = top - ((height - blockHeight) / 2) - size;
    lines.forEach((line) => {
      const textWidth = font.widthOfTextAtSize(line, size);
      const textX = align === 'center'
        ? x + Math.max(padding, (width - textWidth) / 2)
        : align === 'right'
          ? x + width - padding - textWidth
          : x + padding;
      page.drawText(line, { x: textX, y: textY, size, font, color: black });
      textY -= lineHeight;
    });
  };

  const row = (values, widths, height, options = []) => {
    let x = left;
    values.forEach((value, index) => {
      cell(value, x, cursor, widths[index], height, options[index] || {});
      x += widths[index];
    });
    cursor -= height;
  };

  const band = (value, height, fill, size = 7.2) => {
    cell(value, left, cursor, tableWidth, height, { fill, font: bold, size, align: 'center' });
    cursor -= height;
  };

  // Branded heading from the approved front-sheet format.
  page.drawRectangle({ x: left, y: cursor - 62, width: tableWidth, height: 62, color: white, borderColor: black, borderWidth: 0.35 });
  page.drawText('VIVID', { x: 57, y: cursor - 29, size: 19, font: bold, color: brandRed });
  page.drawText('ELECTRIFYING THE FUTURE', { x: 57, y: cursor - 44, size: 5.5, font: bold, color: brandGreen });
  page.drawText('Vivid Electromech Pvt. Ltd.', { x: 180, y: cursor - 32, size: 21, font: bold, color: brandRed });
  cursor -= 62;

  const documentDate = poDate(sales.po_date || sheet.updated_at);
  row(
    ['PROJECT COMMERCIAL CLOSURE FORMAT - FRONT SHEET', 'DATE :-', documentDate],
    [390, 70, 72],
    14,
    [{ font: bold, size: 7.2, align: 'center' }, { font: bold, size: 6.5, align: 'right' }, { font: bold, size: 6.5, align: 'right', fill: salesFill }],
  );
  band('This colour cell to be filled manually by Sales Engg.', 12, salesFill, 6.2);
  band('FOR SALES USE ONLY', 14, salesBand, 7.5);

  const poNumber = sales.po_number || autoPoNumber(request);
  const projectRows = [
    ['CLIENT NAME', sales.client_name || request.company_name],
    ['PROJECT NAME', sales.project_name || request.enquiry_product],
    ['SITE LOCATION', sales.site_location || request.site_location],
    ['QUOTATION REF NO', sales.quotation_ref || request.quotation_number],
    ['PO/LOI NO & DATE', `${poNumber} Dated ${documentDate}`],
    ['CUSTOMER CONTACT DETAILS (TECH)', sales.tech_contact || request.contact_person_name],
    ['CUSTOMER CONTACT DETAILS (COMM)', sales.comm_contact || request.contact_person_name],
    ['CONSULTANT', sales.consultant || request.consultant || 'NA'],
    ['BASIC VALUE (Without GST)', poAmount(sales.basic_value || request.quotation_total, 'Rs. 0')],
  ];
  projectRows.forEach(([label, value], index) => row(
    [String(index + 1), label, value || '-'],
    [18, 148, 366],
    10.8,
    [{ font: bold, size: 5.7, align: 'center' }, { font: bold, size: 5.7 }, { font: bold, size: 5.8, fill: salesFill }],
  ));

  band('COMMERCIAL TERMS AGREED BY SALES TEAM', 14, white, 7);
  row(
    ['SR.', 'DESCRIPTION', 'STANDARD GUIDELINES', 'TO BE FILLED BY SALES ENGG'],
    [18, 148, 250, 116],
    14,
    Array(4).fill({ font: bold, size: 6.2, align: 'center' }),
  );

  const salesRows = [
    { sr: '1', label: 'LOI / PO', guideline: 'Received/Not Received/Email or Verbal Confirmation', value: sales.loi_po_status, height: 10.5 },
    { sr: '2', label: 'Drawing Submission', guideline: 'Approx 7 Days after receipt of PO/LOI', value: sales.drawing_submission, height: 10.5 },
    { sr: '3', label: 'Payment Terms', guideline: '', value: sales.payment_terms, height: 10.5 },
    { sr: 'a.', label: 'Advance %', guideline: 'Min 10% advance', value: sales.advance_percent, height: 10.5 },
    { sr: 'b.', label: 'ABG to be given for advance', guideline: 'Required/Not Required in %', value: sales.abg_advance, height: 10.5 },
    { sr: 'c.', label: 'Balance', guideline: 'Proforma Invoice /60 days LC/PDC /VFS/OPEN', value: sales.balance_terms, height: 21 },
    { sr: 'd.', label: 'Warranty', guideline: '12 / 24 / 30 Months From Supply', value: sales.warranty, height: 15 },
    { sr: 'e.', label: 'PBG/Corporate Guarantee', guideline: 'Required/Not Required in %', value: sales.pbg_corporate_guarantee, height: 10.5 },
    { sr: '4', label: 'Delivery Time Commited', guideline: 'Standard 6 to 8 weeks FROM DRAWING APPROVAL', value: sales.delivery_time, height: 13 },
    { sr: '5', label: 'Commissioning Support', guideline: 'For HT PO value above 12L and LT PO above 20 and within 100 Kms of Pune or Mumbai will be free supervision only; all other support is chargeable.', value: sales.commissioning_support, height: 26 },
    { sr: '6', label: 'Commissioning Support in Rs.', guideline: 'If above criteria are not fulfilled mention the amount in Rs.', value: poAmount(sales.commissioning_support_rs, ''), height: 12 },
    { sr: '7', label: 'Taxes & Duties', guideline: 'a) 18% GST / 0.1% / Export / SEZ', value: sales.taxes_duties, height: 11 },
    { sr: '8', label: 'Transportation', guideline: 'Customer Scope / Vivid Scope (Transportation Value in Rs. Considered)', value: poAmount(sales.transportation, ''), height: 13 },
    { sr: '9', label: 'Customer / Consultant Liaisoning', guideline: 'To be Considered in Rs.', value: poAmount(sales.liaisoning, ''), height: 11 },
    { sr: '10', label: 'Special Packing Charges if required', guideline: 'If special, to be Considered in Rs.', value: poAmount(sales.packing_charges, ''), height: 11 },
    { sr: '11', label: 'Unloading and Installation', guideline: 'Specify', value: sales.unloading_installation, height: 11 },
    { sr: '12', label: 'Finance Charges', guideline: 'Hundi / LC / Above 30 days', value: poAmount(sales.finance_charges, ''), height: 11 },
    { sr: '13', label: 'Any Special Payment Terms / Note', guideline: '', value: sales.special_note, height: 27 },
  ];
  salesRows.forEach((item) => row(
    [item.sr, item.label, item.guideline, item.value || '-'],
    [18, 148, 250, 116],
    item.height,
    [{ font: bold, size: 5.4, align: 'center' }, { font: bold, size: 5.5 }, { size: 5.25, align: 'center' }, { size: 5.5, align: 'center', fill: salesFill }],
  ));

  band('This colour cell to be filled manually by Estimation HOD', 13, estimationFill, 6.2);
  band('FOR ESTIMATION USE ONLY', 14, salesBand, 7.5);

  const estimationRows = [
    { sr: '1', label: 'PO VALUE (WITHOUT GST) SALES', value: poAmount(est.po_value || sales.basic_value || request.quotation_total) },
    { sr: '2', label: 'Basic value without Margin & Overhead', value: poAmount(est.basic_without_margin) },
    { sr: '3', label: 'Add Transportation Charges', guideline: 'Vivid Scope/Customer Scope', detail: est.transportation_scope, value: poAmount(est.transportation_charges) },
    { sr: '4', label: 'Add Customer / Consultant Liaisoning', value: poAmount(est.liaisoning) },
    { sr: '5', label: 'Add Special Packing Charges if required', guideline: 'Standard / Wooden / Seaworthy Extra', detail: est.packing_scope, value: poAmount(est.packing_charges) },
    { sr: '6', label: 'Add Commissioning Support', guideline: 'Customer Scope / Vivid Scope', detail: est.commissioning_scope, value: poAmount(est.commissioning_support) },
    { sr: '7', label: 'Add Unloading and installation', guideline: 'Customer Scope / Vivid Scope', detail: est.unloading_scope, value: poAmount(est.unloading_installation) },
    { sr: '8', label: 'Add Finance Charges', guideline: 'Hundi / LC / Above 30 days', value: poAmount(est.finance_charges) },
    { sr: 'A', label: 'Total of all expenses', value: poAmount(est.total_expenses) },
    { sr: 'B', label: 'Overhead in percentage', detail: est.overhead_percent, value: poAmount(est.overhead_amount) },
    { sr: 'C', label: 'Net MARGIN', detail: est.net_margin_percent, value: poAmount(est.net_margin_amount) },
  ];
  estimationRows.forEach((item) => row(
    [item.sr, item.label, item.guideline || '', item.detail || '', item.value || '-'],
    [18, 148, 176, 74, 116],
    10.5,
    [
      { font: bold, size: 5.4, align: 'center' },
      { font: bold, size: 5.4 },
      { size: 5.1, align: 'center' },
      { font: bold, size: 5.4, align: 'center', fill: estimationFill },
      { font: bold, size: 5.5, align: 'right', fill: estimationFill },
    ],
  ));

  band('SWITCHGEAR MAKE & BASIC RATES', 13, estimationFill, 7);
  const rateRows = [
    { sr: 'A', label: 'SWITCHGEAR MAKE', guideline: 'ABB/SCHNEIDER/L&T', standard: '', value: est.switchgear_make },
    { sr: 'B', label: 'FABRICATION RATE', guideline: 'CRCA/SS/GI', standard: '150/Kg', value: poAmount(est.fabrication_rate) },
    { sr: 'C', label: 'ALUMINIUM RATE', guideline: '', standard: '450/Kg', value: poAmount(est.aluminium_rate) },
    { sr: 'D', label: 'COPPER RATE', guideline: 'BARE/TINNED', standard: '1500/Kg', value: poAmount(est.copper_rate) },
  ];
  rateRows.forEach((item) => row(
    [item.sr, item.label, item.guideline, item.standard, item.value || '-'],
    [18, 148, 176, 74, 116],
    10.5,
    [
      { font: bold, size: 5.4, align: 'center' },
      { font: bold, size: 5.4 },
      { size: 5.2, align: 'center' },
      { size: 5.2, align: 'center' },
      { font: bold, size: 5.5, align: 'center', fill: estimationFill },
    ],
  ));
  row(
    ['E', 'NOTE-', est.note || '', '', ''],
    [18, 148, 176, 74, 116],
    20,
    [{ font: bold, size: 5.4, align: 'center' }, { font: bold, size: 5.4 }, { size: 5.3, fill: estimationFill }, { fill: estimationFill }, { fill: estimationFill }],
  );

  row(
    ['', '', 'NAME', 'SIGNATURE'],
    [18, 148, 250, 116],
    11,
    [{}, {}, { font: bold, size: 6, align: 'center' }, { font: bold, size: 6, align: 'center' }],
  );
  const approvalRows = [
    ['Order Finalized by', est.finalized_by || sheet.sales_submitted_by_name || '-', ''],
    ['HOD Approval', est.hod_approval || sheet.head_approved_by_name || '-', sheet.head_approved_at ? `Approved ${poDate(sheet.head_approved_at)}` : ''],
    ['MD Approval', est.md_approval || '-', ''],
  ];
  approvalRows.forEach(([label, name, signature]) => row(
    ['', label, name, signature],
    [18, 148, 250, 116],
    14,
    [{}, { font: bold, size: 5.8, align: 'center' }, { size: 5.8, align: 'center', fill: salesFill }, { size: 5.2, align: 'center' }],
  ));

  return pdfDoc.save();
}

async function generatePoSheetPdf(id, user) {
  const request = await getRequest(id, user);
  const sheet = await getPoSheet(id, user);
  const poNumber = sheet.sales_data?.po_number || autoPoNumber(request);
  return {
    filename: `Front-Sheet-${safePdfFilename(poNumber)}.pdf`,
    pdf: await buildPoFrontSheetPdf(request, sheet),
  };
}

module.exports = {
  buildPoFrontSheetPdf,
  generatePoSheetPdf,
  getPoSheet,
  approvePoSheet,
  savePoEstimation,
  upsertPoSheet,
  discardRequest,
  markClientApproved,
  requestSalesRevision,
  approveRequest,
  assignRequest,
  createOrUpdateRequestQuotation,
  getRequest,
  listEstimationRequests,
  markQuotationSent,
  requestRevision,
  submitForReview,
  submitLeadToEstimation,
};
