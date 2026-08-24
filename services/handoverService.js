const pool = require('../config/db_connection');
const { logLeadActivity } = require('../controller/leads');
const { createProjectFromHandover } = require('./projectService');

const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const EDITABLE_STATUSES = new Set(['draft', 'ready', 'rejected']);

function appError(message, statusCode = 400, extras = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extras);
  return error;
}

function actorName(user) {
  return user?.name || 'Workspace user';
}

function normalizeRole(role) {
  return String(role || 'salesperson').trim().toLowerCase();
}

function requireSalesUser(user) {
  const role = normalizeRole(user?.role);
  if (!['admin', 'salesperson'].includes(role)) {
    throw appError('Only CRM sales users or admin can create and submit ERP handovers.', 403);
  }
}

function requireErpUser(user) {
  const role = normalizeRole(user?.role);
  if (!['admin', 'erp'].includes(role)) {
    throw appError('Only ERP users or admin can accept or reject handovers.', 403);
  }
}

function text(value, field, maxLength, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw appError(`${field} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw appError(`${field} must be text.`);
  const result = value.trim();
  if (required && !result) throw appError(`${field} is required.`);
  if (result.length > maxLength) throw appError(`${field} is too long.`);
  return result || null;
}

function positiveInteger(value, field, required = true) {
  if ((value === undefined || value === null || value === '') && !required) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw appError(`${field} must be a whole number greater than zero.`);
  return number;
}

function normalizeDate(value, field, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw appError(`${field} is required.`);
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw appError(`${field} must use YYYY-MM-DD format.`);
  return value;
}

function normalizePriority(value) {
  const priority = String(value || 'normal').trim().toLowerCase();
  if (!PRIORITIES.has(priority)) throw appError('Priority is invalid.');
  return priority;
}

function normalizeHandoverInput(data = {}, { requireProjectName = false } = {}) {
  return {
    quotationId: positiveInteger(data.quotation_id, 'Quotation'),
    salesOrderId: positiveInteger(data.sales_order_id, 'Sales order', false),
    projectName: text(data.project_name, 'Project name', 255, requireProjectName),
    priority: normalizePriority(data.priority),
    requestedDeliveryDate: normalizeDate(data.requested_delivery_date, 'Requested delivery date'),
    commercialNotes: text(data.commercial_notes, 'Commercial notes', 5000),
    technicalNotes: text(data.technical_notes, 'Technical notes', 5000),
    internalNotes: text(data.internal_notes, 'Internal notes', 5000),
    customerPoNumber: text(data.customer_po_number, 'Customer PO number', 100),
    customerPoDate: normalizeDate(data.customer_po_date, 'Customer PO date'),
  };
}

async function generateHandoverNumber(client) {
  const sequence = await client.query(`SELECT nextval('handover_number_seq') AS number`);
  return `HO-${new Date().getFullYear()}-${String(sequence.rows[0].number).padStart(4, '0')}`;
}

function handoverSelect(whereClause = '', orderClause = 'ORDER BY h.created_at DESC, h.id DESC') {
  return `
    SELECT h.*,
      c.company_name AS customer_name,
      c.contact_person_name AS customer_contact_name,
      c.contact_person_phone AS customer_phone,
      q.quotation_number,
      q.total_amount AS quotation_total,
      q.status AS quotation_status,
      l.assigned_to AS sales_owner,
      p.project_number,
      p.status AS project_status,
      p.overall_progress AS project_progress
    FROM crm_erp_handovers h
    JOIN customers c ON c.id = h.customer_id
    JOIN quotations q ON q.id = h.quotation_id
    LEFT JOIN leads l ON l.id = h.lead_id
    LEFT JOIN projects p ON p.id = h.project_id
    ${whereClause}
    ${orderClause}
  `;
}

async function quotationBundle(client, quotationId, lock = false) {
  const result = await client.query(
    `SELECT q.*,
      l.lead_status,
      l.assigned_to,
      l.requirements_summary,
      c.id AS customer_id,
      c.company_name AS customer_company_name,
      c.contact_person_name AS customer_contact_name,
      c.contact_person_phone AS customer_phone,
      c.gstin AS customer_gstin,
      c.city AS customer_city
     FROM quotations q
     LEFT JOIN leads l ON l.id = q.lead_id
     LEFT JOIN LATERAL (
       SELECT *
       FROM customers c
       WHERE c.source_lead_id = l.id
          OR LOWER(c.company_name) = LOWER(q.company_name)
       ORDER BY CASE WHEN c.source_lead_id = l.id THEN 0 ELSE 1 END, c.id
       LIMIT 1
     ) c ON TRUE
     WHERE q.id = $1
     ${lock ? 'FOR UPDATE OF q' : ''}`,
    [quotationId],
  );
  return result.rows[0] || null;
}

function canAccessBundle(bundle, user) {
  return normalizeRole(user?.role) !== 'salesperson' || bundle.assigned_to === user.name;
}

async function checkHandoverEligibility({
  quotationId,
  salesOrderId = null,
  customerPoNumber = null,
  user,
  client = pool,
  excludeHandoverId = null,
  lockQuotation = false,
}) {
  const blockers = [];
  const warnings = [];
  const quotation = await quotationBundle(client, quotationId, lockQuotation);

  if (!quotation) {
    return { eligible: false, blockers: ['Quotation not found.'], warnings: [], quotation: null, customer: null, salesOrder: null };
  }

  if (!canAccessBundle(quotation, user)) blockers.push('You can hand over only quotations for your assigned leads.');
  if (!quotation.customer_id) blockers.push('Customer account is missing.');

  const accepted = quotation.status === 'Approved'
    || (quotation.status === 'Sent' && quotation.lead_status === 'Proposal Accepted');
  if (!accepted) blockers.push('Quotation is not accepted or approved.');

  const poNumber = customerPoNumber || quotation.customer_po_number;
  if (!poNumber) blockers.push('Customer PO is missing.');
  if (!quotation.customer_po_date) warnings.push('Customer PO date is missing.');

  const pendingApproval = await client.query(
    `SELECT ar.id
     FROM approval_requests ar
     JOIN negotiations n ON n.id = ar.record_id AND ar.module = 'negotiation'
     WHERE n.quotation_id = $1
       AND ar.status = 'pending'
     LIMIT 1`,
    [quotationId],
  );
  if (pendingApproval.rows[0]) blockers.push('GA approval is still pending.');

  const pendingNegotiation = await client.query(
    `SELECT id
     FROM negotiations
     WHERE quotation_id = $1
       AND status = 'pending_approval'
     LIMIT 1`,
    [quotationId],
  );
  if (pendingNegotiation.rows[0]) blockers.push('Negotiation approval is still pending.');

  const duplicateParams = [quotationId];
  let duplicateWhere = `quotation_id = $1 AND status NOT IN ('rejected', 'cancelled')`;
  if (excludeHandoverId) {
    duplicateParams.push(excludeHandoverId);
    duplicateWhere += ` AND id <> $${duplicateParams.length}`;
  }
  const existingHandover = await client.query(
    `SELECT id, handover_number, status
     FROM crm_erp_handovers
     WHERE ${duplicateWhere}
     LIMIT 1`,
    duplicateParams,
  );
  if (existingHandover.rows[0]) blockers.push(`Order already has handover ${existingHandover.rows[0].handover_number}.`);

  if (salesOrderId) {
    const existingSalesOrder = await client.query(
      `SELECT id, handover_number
       FROM crm_erp_handovers
       WHERE sales_order_id = $1
         AND status NOT IN ('rejected', 'cancelled')
         ${excludeHandoverId ? 'AND id <> $2' : ''}
       LIMIT 1`,
      excludeHandoverId ? [salesOrderId, excludeHandoverId] : [salesOrderId],
    );
    if (existingSalesOrder.rows[0]) blockers.push(`Sales order already has handover ${existingSalesOrder.rows[0].handover_number}.`);
  }

  const existingProject = await client.query(
    `SELECT project_number
     FROM projects
     WHERE quotation_id = $1
     LIMIT 1`,
    [quotationId],
  );
  if (existingProject.rows[0]) blockers.push(`ERP project ${existingProject.rows[0].project_number} already exists.`);

  return {
    eligible: blockers.length === 0,
    blockers,
    warnings,
    quotation,
    customer: quotation.customer_id ? {
      id: quotation.customer_id,
      company_name: quotation.customer_company_name,
      contact_person_name: quotation.customer_contact_name,
      contact_person_phone: quotation.customer_phone,
      gstin: quotation.customer_gstin,
      city: quotation.customer_city,
    } : null,
    salesOrder: salesOrderId ? { id: salesOrderId } : null,
  };
}

async function buildHandoverSnapshot(client, { handoverData, eligibility }) {
  const q = eligibility.quotation;
  const approvals = await client.query(
    `SELECT ar.approval_type, ar.status, ar.approver_name, ar.comments, ar.approved_at, n.negotiation_type, n.proposed_value
     FROM approval_requests ar
     JOIN negotiations n ON n.id = ar.record_id AND ar.module = 'negotiation'
     WHERE n.quotation_id = $1
     ORDER BY ar.requested_at ASC, ar.id ASC`,
    [q.id],
  );
  const negotiations = await client.query(
    `SELECT negotiation_type, old_value, proposed_value, reason, requested_by_name, status, created_at
     FROM negotiations
     WHERE quotation_id = $1
     ORDER BY created_at ASC, id ASC`,
    [q.id],
  );

  return {
    customer: {
      id: eligibility.customer?.id,
      company_name: eligibility.customer?.company_name || q.company_name,
      contact_name: eligibility.customer?.contact_person_name || q.contact_person_name,
      email: q.contact_person_email || q.billing_email || null,
      phone: eligibility.customer?.contact_person_phone || q.contact_person_phone || q.billing_phone || null,
      gstin: eligibility.customer?.gstin || q.billing_gstin || null,
      city: eligibility.customer?.city || q.billing_city || null,
    },
    quotation: {
      id: q.id,
      quotation_number: q.quotation_number,
      revision: q.revision_number || 0,
      final_value: Number(q.total_amount || 0),
      subtotal: Number(q.subtotal || 0),
      gst_rate: Number(q.gst_rate || 0),
      gst_amount: Number(q.gst_amount || 0),
      currency: 'INR',
      line_items: q.line_items || [],
    },
    order: {
      customer_po_number: handoverData.customerPoNumber || q.customer_po_number,
      po_date: handoverData.customerPoDate || q.customer_po_date || null,
      order_value: Number(q.total_amount || 0),
    },
    commercial: {
      payment_terms: q.payment_terms || null,
      delivery_terms: q.delivery_days ? `${q.delivery_days} days` : null,
      warranty_terms: q.warranty_terms || null,
      discount: Number(q.discount_percent || 0),
      discount_amount: Number(q.discount_amount || 0),
      final_price: q.final_price === null ? null : Number(q.final_price),
      notes: handoverData.commercialNotes || null,
    },
    technical: {
      project_name: handoverData.projectName,
      scope: q.notes || q.negotiation_notes || q.requirements_summary || null,
      product_type: null,
      quantity: Array.isArray(q.line_items) ? q.line_items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0) : 0,
      special_requirements: handoverData.technicalNotes || null,
    },
    delivery: {
      requested_delivery_date: handoverData.requestedDeliveryDate,
      committed_delivery_date: handoverData.requestedDeliveryDate,
      site_location: [q.billing_city, q.billing_state, q.billing_pincode].filter(Boolean).join(', ') || null,
      installation_required: false,
      customer_inspection_required: false,
    },
    approvals: approvals.rows.map((item) => ({
      type: item.approval_type,
      status: item.status,
      approver_name: item.approver_name,
      comments: item.comments,
      approved_at: item.approved_at,
      negotiation_type: item.negotiation_type,
      proposed_value: item.proposed_value,
    })),
    negotiations: negotiations.rows,
    notes: {
      commercial: handoverData.commercialNotes || null,
      technical: handoverData.technicalNotes || null,
      internal: handoverData.internalNotes || null,
    },
    frozen_at: new Date().toISOString(),
  };
}

async function createHandover(data, user) {
  requireSalesUser(user);
  const values = normalizeHandoverInput(data, { requireProjectName: true });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const quotation = await quotationBundle(client, values.quotationId, true);
    if (!quotation) throw appError('Quotation not found.', 404);

    if (values.customerPoNumber || values.customerPoDate) {
      await client.query(
        `UPDATE quotations
         SET customer_po_number = COALESCE($1, customer_po_number),
             customer_po_date = COALESCE($2, customer_po_date),
             order_confirmed_at = CASE
               WHEN COALESCE($1, customer_po_number) IS NOT NULL AND order_confirmed_at IS NULL THEN CURRENT_TIMESTAMP
               ELSE order_confirmed_at
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [values.customerPoNumber, values.customerPoDate, values.quotationId],
      );
    }

    const eligibility = await checkHandoverEligibility({
      quotationId: values.quotationId,
      salesOrderId: values.salesOrderId,
      customerPoNumber: values.customerPoNumber,
      user,
      client,
      lockQuotation: true,
    });
    if (!eligibility.eligible) {
      throw appError(eligibility.blockers[0] || 'Handover is not eligible.', 400, { blockers: eligibility.blockers });
    }

    const handoverNumber = await generateHandoverNumber(client);
    const snapshot = await buildHandoverSnapshot(client, { handoverData: values, eligibility });
    const result = await client.query(
      `INSERT INTO crm_erp_handovers (
        handover_number,
        customer_id,
        lead_id,
        quotation_id,
        sales_order_id,
        status,
        project_name,
        priority,
        requested_delivery_date,
        commercial_notes,
        technical_notes,
        internal_notes,
        customer_po_number,
        customer_po_date,
        snapshot,
        created_by_name,
        created_by_role
      ) VALUES ($1, $2, $3, $4, $5, 'ready', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *`,
      [
        handoverNumber,
        eligibility.customer.id,
        eligibility.quotation.lead_id,
        values.quotationId,
        values.salesOrderId,
        values.projectName,
        values.priority,
        values.requestedDeliveryDate,
        values.commercialNotes,
        values.technicalNotes,
        values.internalNotes,
        values.customerPoNumber || eligibility.quotation.customer_po_number,
        values.customerPoDate || eligibility.quotation.customer_po_date,
        JSON.stringify(snapshot),
        actorName(user),
        user?.role || null,
      ],
    );
    const handover = result.rows[0];

    await logLeadActivity(handover.lead_id, {
      activity_type: 'system',
      content: `ERP handover ${handover.handover_number} created.`,
      metadata: { handover_id: handover.id, handover_number: handover.handover_number, quotation_id: handover.quotation_id },
    }, user, client);

    await client.query('COMMIT');
    return getHandover(handover.id, user);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function listHandovers(user) {
  const role = normalizeRole(user?.role);
  const params = [];
  let where = '';
  if (role === 'salesperson') {
    params.push(actorName(user));
    where = 'WHERE h.created_by_name = $1 OR l.assigned_to = $1';
  }
  const result = await pool.query(handoverSelect(where), params);
  return result.rows;
}

async function getHandover(id, user) {
  const result = await pool.query(handoverSelect('WHERE h.id = $1', ''), [id]);
  const handover = result.rows[0];
  if (!handover) throw appError('Handover not found.', 404);
  if (normalizeRole(user?.role) === 'salesperson' && handover.created_by_name !== actorName(user) && handover.sales_owner !== actorName(user)) {
    throw appError('You can view only your own handovers.', 403);
  }
  return handover;
}

async function updateHandover(id, data, user) {
  requireSalesUser(user);
  const values = normalizeHandoverInput(data, { requireProjectName: true });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM crm_erp_handovers WHERE id = $1 FOR UPDATE', [id]);
    const handover = existing.rows[0];
    if (!handover) throw appError('Handover not found.', 404);
    if (!EDITABLE_STATUSES.has(handover.status)) throw appError(`Cannot edit a ${handover.status} handover.`, 409);

    await client.query(
      `UPDATE quotations
       SET customer_po_number = COALESCE($1, customer_po_number),
           customer_po_date = COALESCE($2, customer_po_date),
           order_confirmed_at = CASE
             WHEN COALESCE($1, customer_po_number) IS NOT NULL AND order_confirmed_at IS NULL THEN CURRENT_TIMESTAMP
             ELSE order_confirmed_at
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [values.customerPoNumber, values.customerPoDate, values.quotationId],
    );

    const eligibility = await checkHandoverEligibility({
      quotationId: values.quotationId,
      salesOrderId: values.salesOrderId,
      customerPoNumber: values.customerPoNumber || handover.customer_po_number,
      user,
      client,
      excludeHandoverId: handover.id,
      lockQuotation: true,
    });
    if (!eligibility.eligible) throw appError(eligibility.blockers[0] || 'Handover is not eligible.', 400, { blockers: eligibility.blockers });

    const snapshot = await buildHandoverSnapshot(client, { handoverData: values, eligibility });
    await client.query(
      `UPDATE crm_erp_handovers
       SET sales_order_id = $1,
           status = 'ready',
           project_name = $2,
           priority = $3,
           requested_delivery_date = $4,
           commercial_notes = $5,
           technical_notes = $6,
           internal_notes = $7,
           customer_po_number = $8,
           customer_po_date = $9,
           rejection_reason = NULL,
           snapshot = $10,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $11`,
      [
        values.salesOrderId,
        values.projectName,
        values.priority,
        values.requestedDeliveryDate,
        values.commercialNotes,
        values.technicalNotes,
        values.internalNotes,
        values.customerPoNumber || eligibility.quotation.customer_po_number,
        values.customerPoDate || eligibility.quotation.customer_po_date,
        JSON.stringify(snapshot),
        handover.id,
      ],
    );

    await client.query('COMMIT');
    return getHandover(id, user);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function submitHandover(id, user) {
  requireSalesUser(user);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM crm_erp_handovers WHERE id = $1 FOR UPDATE', [id]);
    const handover = existing.rows[0];
    if (!handover) throw appError('Handover not found.', 404);
    if (!['draft', 'ready', 'rejected'].includes(handover.status)) throw appError(`Cannot submit a ${handover.status} handover.`, 409);
    if (!handover.project_name) throw appError('Project name is required before submission.');
    if (!handover.requested_delivery_date) throw appError('Requested delivery date is required before submission.');

    const eligibility = await checkHandoverEligibility({
      quotationId: handover.quotation_id,
      salesOrderId: handover.sales_order_id,
      customerPoNumber: handover.customer_po_number,
      user,
      client,
      excludeHandoverId: handover.id,
      lockQuotation: true,
    });
    if (!eligibility.eligible) throw appError(eligibility.blockers[0] || 'Handover is not eligible.', 400, { blockers: eligibility.blockers });

    const snapshot = await buildHandoverSnapshot(client, {
      handoverData: {
        projectName: handover.project_name,
        requestedDeliveryDate: handover.requested_delivery_date,
        commercialNotes: handover.commercial_notes,
        technicalNotes: handover.technical_notes,
        internalNotes: handover.internal_notes,
        customerPoNumber: handover.customer_po_number,
        customerPoDate: handover.customer_po_date,
      },
      eligibility,
    });

    await client.query(
      `UPDATE crm_erp_handovers
       SET status = 'submitted',
           submitted_by_name = $1,
           submitted_by_role = $2,
           submitted_at = CURRENT_TIMESTAMP,
           rejected_by_name = NULL,
           rejected_by_role = NULL,
           rejected_at = NULL,
           rejection_reason = NULL,
           snapshot = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [actorName(user), user?.role || null, JSON.stringify(snapshot), handover.id],
    );

    await logLeadActivity(handover.lead_id, {
      activity_type: 'system',
      content: `ERP handover ${handover.handover_number} submitted for review.`,
      metadata: { handover_id: handover.id, handover_number: handover.handover_number, quotation_id: handover.quotation_id },
    }, user, client);

    await client.query('COMMIT');
    return getHandover(id, user);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function acceptHandover(id, data, user) {
  requireErpUser(user);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM crm_erp_handovers WHERE id = $1 FOR UPDATE', [id]);
    const handover = existing.rows[0];
    if (!handover) throw appError('Handover not found.', 404);
    if (handover.status !== 'submitted') throw appError(`Cannot accept a ${handover.status} handover.`, 409);
    if (handover.project_id) throw appError('Project already exists for this handover.', 409);

    const project = await createProjectFromHandover(client, handover, user, data);
    await client.query(
      `UPDATE crm_erp_handovers
       SET status = 'project_created',
           accepted_by_name = $1,
           accepted_by_role = $2,
           accepted_at = CURRENT_TIMESTAMP,
           project_id = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [actorName(user), user?.role || null, project.id, handover.id],
    );

    await logLeadActivity(handover.lead_id, {
      activity_type: 'system',
      content: `ERP handover ${handover.handover_number} accepted by ${actorName(user)}.`,
      metadata: { handover_id: handover.id, handover_number: handover.handover_number, project_id: project.id, project_number: project.project_number },
    }, user, client);
    await logLeadActivity(handover.lead_id, {
      activity_type: 'system',
      content: `ERP project ${project.project_number} created.`,
      metadata: { handover_id: handover.id, handover_number: handover.handover_number, project_id: project.id, project_number: project.project_number },
    }, user, client);

    await client.query('COMMIT');
    return { handover: await getHandover(id, user), project };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function rejectHandover(id, data, user) {
  requireErpUser(user);
  const reason = text(data?.reason, 'Rejection reason', 5000, true);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM crm_erp_handovers WHERE id = $1 FOR UPDATE', [id]);
    const handover = existing.rows[0];
    if (!handover) throw appError('Handover not found.', 404);
    if (handover.status !== 'submitted') throw appError(`Cannot reject a ${handover.status} handover.`, 409);

    await client.query(
      `UPDATE crm_erp_handovers
       SET status = 'rejected',
           rejected_by_name = $1,
           rejected_by_role = $2,
           rejected_at = CURRENT_TIMESTAMP,
           rejection_reason = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [actorName(user), user?.role || null, reason, handover.id],
    );

    await logLeadActivity(handover.lead_id, {
      activity_type: 'system',
      content: `ERP handover ${handover.handover_number} rejected. Reason: ${reason}`,
      metadata: { handover_id: handover.id, handover_number: handover.handover_number, quotation_id: handover.quotation_id },
    }, user, client);

    await client.query('COMMIT');
    return getHandover(id, user);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  acceptHandover,
  buildHandoverSnapshot,
  checkHandoverEligibility,
  createHandover,
  getHandover,
  listHandovers,
  rejectHandover,
  submitHandover,
  updateHandover,
};
