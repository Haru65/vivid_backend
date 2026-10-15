const pool = require('../config/db_connection');
const { logLeadActivity } = require('./leads');
const { sendEmail } = require('../services/emailService');
const { generateQuotationPdf } = require('../services/quotationGeneration');

const GLOBAL_VIEW_ROLES = new Set(['admin', 'sales_head', 'estimation_head']);
const PREPARATION_ROLES = new Set(['admin', 'estimation_head', 'estimation_engineer']);
const SALES_ROLES = new Set(['admin', 'sales_head', 'sales_engineer', 'salesperson']);

function appError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validationError(message) {
  return appError(message, 400);
}

function roleOf(user) {
  return String(user?.role || '').trim().toLowerCase();
}

function actorName(user) {
  return String(user?.name || '').trim();
}

function sameId(left, right) {
  return String(left || '') !== '' && String(left || '') === String(right || '');
}

function sameName(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function isIndividualSales(user) {
  return ['salesperson', 'sales_engineer'].includes(roleOf(user));
}

function canViewQuotation(quotation, user) {
  const role = roleOf(user);
  if (GLOBAL_VIEW_ROLES.has(role)) return true;
  if (isIndividualSales(user)) {
    return sameId(quotation.sales_owner_id, user?.id) || sameName(quotation.assigned_to, actorName(user));
  }
  if (role === 'estimation_engineer') {
    return sameId(quotation.prepared_by_user_id, user?.id)
      || sameId(quotation.assigned_engineer_id, user?.id);
  }
  return false;
}

function canManageQuotation(quotation, user) {
  const role = roleOf(user);
  if (['admin', 'estimation_head'].includes(role)) return true;
  return role === 'estimation_engineer'
    && (sameId(quotation.prepared_by_user_id, user?.id) || sameId(quotation.assigned_engineer_id, user?.id));
}

function canSendQuotationToClient(quotation, user) {
  if (!SALES_ROLES.has(roleOf(user))) return false;
  if (['admin', 'sales_head'].includes(roleOf(user))) return true;
  return sameId(quotation.sales_owner_id, user?.id) || sameName(quotation.assigned_to, actorName(user));
}

function quotationSelect(whereClause = '', orderClause = '') {
  return `
    SELECT q.*,
      l.assigned_to,
      NULLIF(to_jsonb(l)->>'sales_owner_id', '')::BIGINT AS sales_owner_id,
      er.assigned_engineer_id,
      (SELECT er.status FROM estimation_requests er WHERE er.id = q.estimation_request_id) AS estimation_status,
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
      ), '[]'::json) AS negotiations,
      (
        SELECT json_build_object(
          'id', h.id,
          'handover_number', h.handover_number,
          'handover_status', h.status,
          'project_id', h.project_id,
          'project_number', p.project_number,
          'project_status', p.status
        )
        FROM crm_erp_handovers h
        LEFT JOIN projects p ON p.id = h.project_id
        WHERE h.quotation_id = q.id
        ORDER BY h.created_at DESC, h.id DESC
        LIMIT 1
      ) AS erp_handover
    FROM quotations q
    LEFT JOIN leads l ON l.id = q.lead_id
    LEFT JOIN estimation_requests er ON er.id = q.estimation_request_id
    ${whereClause}
    ${orderClause}
  `;
}

async function quotationForAccess(db, id, user, { lock = false, permission = 'view' } = {}) {
  const result = await db.query(
    `SELECT q.*,
       l.assigned_to,
       NULLIF(to_jsonb(l)->>'sales_owner_id', '')::BIGINT AS sales_owner_id,
       er.assigned_engineer_id,
       er.status AS estimation_status
     FROM quotations q
     LEFT JOIN leads l ON l.id = q.lead_id
     LEFT JOIN estimation_requests er ON er.id = q.estimation_request_id
     WHERE q.id = $1
     ${lock ? 'FOR UPDATE OF q' : ''}`,
    [id],
  );
  const quotation = result.rows[0];
  if (!quotation) throw appError('Quotation not found.', 404);

  const allowed = permission === 'manage'
    ? canManageQuotation(quotation, user)
    : permission === 'revision'
      ? canManageQuotation(quotation, user)
    : permission === 'send'
      ? canSendQuotationToClient(quotation, user)
      : canViewQuotation(quotation, user);
  if (!allowed) throw appError('You do not have permission to access this quotation.', 403);
  return quotation;
}

async function enrichedQuotation(id, user, db = pool) {
  if (user) await quotationForAccess(db, id, user);
  const result = await db.query(quotationSelect('WHERE q.id = $1'), [id]);
  return result.rows[0] || null;
}

function requiredString(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw validationError(`${field} is required.`);
  const result = value.trim();
  if (result.length > maxLength) throw validationError(`${field} is too long.`);
  return result;
}

function nullableString(value, field, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw validationError(`${field} must be text.`);
  const result = value.trim();
  if (result.length > maxLength) throw validationError(`${field} is too long.`);
  return result || null;
}

function nullableEmail(value, field) {
  const email = nullableString(value, field, 255);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw validationError(`${field} must be a valid email address.`);
  return email ? email.toLowerCase() : null;
}

function nullablePhone(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const phone = String(value).replace(/\D/g, '');
  if (phone.length !== 10) throw validationError(`${field} must be exactly 10 digits.`);
  return phone;
}

function nullableGstin(value) {
  const gstin = nullableString(value, 'Billing GSTIN', 15);
  if (!gstin) return null;
  const normalized = gstin.toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(normalized)) {
    throw validationError('Billing GSTIN must be a valid 15-character GSTIN.');
  }
  return normalized;
}

function nullablePincode(value) {
  const pincode = nullableString(value, 'Billing pincode', 6);
  if (pincode && !/^\d{6}$/.test(pincode)) throw validationError('Billing pincode must be exactly 6 digits.');
  return pincode;
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw validationError(`${field} must be a whole number greater than zero.`);
  return number;
}

function nonNegativeNumber(value, field, defaultValue = 0) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw validationError(`${field} must be zero or more.`);
  return number;
}

function nonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw validationError(`${field} must be a whole number of zero or more.`);
  return number;
}

function normalizeDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validationError(`${field} must use YYYY-MM-DD format.`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw validationError(`${field} must be a valid date.`);
  return value;
}

function normalizeLineItems(items) {
  if (!Array.isArray(items) || !items.length) throw validationError('Add at least one quotation line item.');
  return items.map((item, index) => {
    const description = requiredString(item?.description, `Line item ${index + 1} description`, 500);
    const quantity = positiveInteger(item?.quantity, `Line item ${index + 1} quantity`);
    const unitPrice = nonNegativeNumber(item?.unit_price, `Line item ${index + 1} unit price`);
    return {
      description,
      quantity,
      unit_price: unitPrice,
      amount: Number((quantity * unitPrice).toFixed(2)),
      price_point_code: nullableString(item?.price_point_code, `Line item ${index + 1} price point code`, 50),
      unit: nullableString(item?.unit, `Line item ${index + 1} unit`, 30) || 'No.',
      master_rate: nonNegativeNumber(item?.master_rate, `Line item ${index + 1} master rate`, unitPrice),
    };
  });
}

function normalizeTechnicalNotes(items) {
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) throw validationError('Technical notes must be a list.');
  const seen = new Set();
  return items.slice(0, 200).map((item, index) => {
    const code = requiredString(item?.code, `Technical note ${index + 1} code`, 50).toUpperCase();
    if (seen.has(code)) throw validationError(`Technical note ${code} is duplicated.`);
    seen.add(code);
    return {
      code,
      section: nullableString(item?.section, `Technical note ${index + 1} section`, 100) || 'General',
      label: requiredString(item?.label, `Technical note ${index + 1} label`, 200),
      pdf_label: nullableString(item?.pdf_label, `Technical note ${index + 1} PDF label`, 200)
        || requiredString(item?.label, `Technical note ${index + 1} label`, 200),
      value: nullableString(item?.value, `Technical note ${index + 1} value`, 1000) || '',
      required: item?.required !== false,
      display_order: Number.isInteger(Number(item?.display_order)) ? Number(item.display_order) : (index + 1) * 10,
    };
  }).sort((left, right) => left.display_order - right.display_order);
}

function normalizedValues(data) {
  const lineItems = normalizeLineItems(data.line_items);
  const subtotal = Number(lineItems.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
  const discountPercent = nonNegativeNumber(data.discount_percent, 'Discount rate', 0);
  if (discountPercent > 100) throw validationError('Discount rate cannot exceed 100%.');
  const discountAmount = Number((subtotal * discountPercent / 100).toFixed(2));
  const taxableAmount = Math.max(0, subtotal - discountAmount);
  const gstRate = nonNegativeNumber(data.gst_rate, 'GST rate', 18);
  if (gstRate > 100) throw validationError('GST rate cannot exceed 100%.');
  const gstAmount = Number((taxableAmount * gstRate / 100).toFixed(2));
  const calculatedTotal = Number((taxableAmount + gstAmount).toFixed(2));
  const finalPrice = data.final_price === undefined || data.final_price === null || data.final_price === ''
    ? null
    : nonNegativeNumber(data.final_price, 'Final price');
  const totalAmount = finalPrice === null ? calculatedTotal : finalPrice;

  return {
    leadId: positiveInteger(data.lead_id, 'Lead'),
    companyName: requiredString(data.company_name, 'Company name', 255),
    contactPersonName: nullableString(data.contact_person_name, 'Contact person name', 255),
    contactPersonEmail: nullableEmail(data.contact_person_email, 'Contact person email'),
    contactPersonPhone: nullablePhone(data.contact_person_phone, 'Contact person phone'),
    billingName: requiredString(data.billing_name, 'Billing name', 255),
    billingAddress: requiredString(data.billing_address, 'Billing address', 5000),
    billingCity: nullableString(data.billing_city, 'Billing city', 255),
    billingState: nullableString(data.billing_state, 'Billing state', 255),
    billingPincode: nullablePincode(data.billing_pincode),
    billingGstin: nullableGstin(data.billing_gstin),
    billingEmail: nullableEmail(data.billing_email, 'Billing email'),
    billingPhone: nullablePhone(data.billing_phone, 'Billing phone'),
    lineItems,
    subtotal,
    gstRate,
    gstAmount,
    totalAmount,
    discountPercent,
    discountAmount,
    finalPrice,
    paymentTerms: nullableString(data.payment_terms, 'Payment terms', 5000),
    deliveryDays: data.delivery_days === undefined || data.delivery_days === null || data.delivery_days === ''
      ? null
      : nonNegativeInteger(data.delivery_days, 'Delivery days'),
    warrantyTerms: nullableString(data.warranty_terms, 'Warranty terms', 5000),
    validUntil: normalizeDate(data.valid_until, 'Valid until'),
    notes: nullableString(data.notes, 'Notes', 5000),
    technicalNotesData: normalizeTechnicalNotes(data.technical_notes_data),
  };
}

async function leadForPreparation(db, leadId, user) {
  const result = await db.query(
    `SELECT l.id, l.company_name, l.contact_person_name, l.contact_person_email, l.contact_person_phone,
       er.assigned_engineer_id
     FROM leads l
     LEFT JOIN LATERAL (
       SELECT assigned_engineer_id
       FROM estimation_requests
       WHERE lead_id = l.id AND status NOT IN ('cancelled', 'discarded')
       ORDER BY updated_at DESC, id DESC
       LIMIT 1
     ) er ON TRUE
     WHERE l.id = $1`,
    [leadId],
  );
  const lead = result.rows[0];
  if (!lead) throw appError('Lead not found.', 404);
  const role = roleOf(user);
  if (!PREPARATION_ROLES.has(role)) throw appError('Only estimation users or admin can prepare quotations.', 403);
  if (role === 'estimation_engineer' && !sameId(lead.assigned_engineer_id, user?.id)) {
    throw appError('Only the assigned estimation engineer can prepare this quotation.', 403);
  }
  return lead;
}

async function retrieveQuotations(user) {
  const role = roleOf(user);
  let where = '';
  let params = [];
  if (isIndividualSales(user)) {
    params = [user?.id || null, actorName(user)];
    where = `WHERE EXISTS (
      SELECT 1 FROM leads l
      WHERE l.id = q.lead_id
        AND (NULLIF(to_jsonb(l)->>'sales_owner_id', '')::BIGINT = $1 OR LOWER(TRIM(l.assigned_to)) = LOWER(TRIM($2)))
    )`;
  } else if (role === 'estimation_engineer') {
    params = [user?.id || null];
    where = `WHERE q.prepared_by_user_id = $1
      OR EXISTS (SELECT 1 FROM estimation_requests er WHERE er.id = q.estimation_request_id AND er.assigned_engineer_id = $1)`;
  } else if (!GLOBAL_VIEW_ROLES.has(role)) {
    throw appError('You do not have permission to view quotations.', 403);
  }
  const result = await pool.query(quotationSelect(where, 'ORDER BY q.created_at DESC, q.id DESC'), params);
  return result.rows;
}

async function generateQuotationDocument(id, user) {
  const quotation = await quotationForAccess(pool, id, user);
  const pdf = await generateQuotationPdf(quotation, user);
  await logLeadActivity(quotation.lead_id, {
    activity_type: 'system',
    content: `Quotation PDF generated for ${quotation.quotation_number}`,
  }, user);
  return { filename: `${quotation.quotation_number}.pdf`, pdf, quotation };
}

async function generateQuotationNumber(db) {
  const sequence = await db.query(`SELECT nextval('quotation_number_seq') AS number`);
  return `QT-${String(sequence.rows[0].number).padStart(5, '0')}`;
}

async function createQuotation(data, user) {
  const values = normalizedValues(data);
  const lead = await leadForPreparation(pool, values.leadId, user);
  const quotationNumber = await generateQuotationNumber(pool);
  const result = await pool.query(
    `INSERT INTO quotations (
      quotation_number, lead_id, company_name, contact_person_name, contact_person_email,
      contact_person_phone, billing_name, billing_address, billing_city, billing_state,
      billing_pincode, billing_gstin, billing_email, billing_phone, line_items, subtotal,
      gst_rate, gst_amount, total_amount, discount_percent, discount_amount, final_price,
      payment_terms, delivery_days, warranty_terms, valid_until, notes, technical_notes_data,
      prepared_by_user_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)
    RETURNING id`,
    [
      quotationNumber,
      values.leadId,
      lead.company_name,
      values.contactPersonName || lead.contact_person_name,
      values.contactPersonEmail || lead.contact_person_email,
      values.contactPersonPhone || lead.contact_person_phone,
      values.billingName,
      values.billingAddress,
      values.billingCity,
      values.billingState,
      values.billingPincode,
      values.billingGstin,
      values.billingEmail,
      values.billingPhone,
      JSON.stringify(values.lineItems),
      values.subtotal,
      values.gstRate,
      values.gstAmount,
      values.totalAmount,
      values.discountPercent,
      values.discountAmount,
      values.finalPrice,
      values.paymentTerms,
      values.deliveryDays,
      values.warrantyTerms,
      values.validUntil,
      values.notes,
      JSON.stringify(values.technicalNotesData),
      user?.id || null,
    ],
  );
  await pool.query('UPDATE quotations SET revision_group_id = id WHERE id = $1 AND revision_group_id IS NULL', [result.rows[0].id]);
  return enrichedQuotation(result.rows[0].id, user);
}

async function updateQuotation(id, data, user) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await quotationForAccess(client, id, user, { lock: true, permission: 'manage' });
    if (existing.status !== 'Draft') throw appError('Only draft quotations can be edited.', 409);
    const values = normalizedValues({ ...data, lead_id: existing.lead_id });
    const lead = await leadForPreparation(client, existing.lead_id, user);
    const result = await client.query(
      `UPDATE quotations
       SET company_name = $1,
           contact_person_name = $2,
           contact_person_email = $3,
           contact_person_phone = $4,
           billing_name = $5,
           billing_address = $6,
           billing_city = $7,
           billing_state = $8,
           billing_pincode = $9,
           billing_gstin = $10,
           billing_email = $11,
           billing_phone = $12,
           line_items = $13,
           subtotal = $14,
           gst_rate = $15,
           gst_amount = $16,
           total_amount = $17,
           discount_percent = $18,
           discount_amount = $19,
           final_price = $20,
           payment_terms = $21,
           delivery_days = $22,
           warranty_terms = $23,
           valid_until = $24,
           notes = $25,
           technical_notes_data = $26,
           prepared_by_user_id = COALESCE(prepared_by_user_id, $27),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $28
       RETURNING id`,
      [
        lead.company_name,
        values.contactPersonName || lead.contact_person_name,
        values.contactPersonEmail || lead.contact_person_email,
        values.contactPersonPhone || lead.contact_person_phone,
        values.billingName,
        values.billingAddress,
        values.billingCity,
        values.billingState,
        values.billingPincode,
        values.billingGstin,
        values.billingEmail,
        values.billingPhone,
        JSON.stringify(values.lineItems),
        values.subtotal,
        values.gstRate,
        values.gstAmount,
        values.totalAmount,
        values.discountPercent,
        values.discountAmount,
        values.finalPrice,
        values.paymentTerms,
        values.deliveryDays,
        values.warrantyTerms,
        values.validUntil,
        values.notes,
        JSON.stringify(values.technicalNotesData),
        user?.id || null,
        id,
      ],
    );
    await client.query('COMMIT');
    return enrichedQuotation(result.rows[0].id, user);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function createQuotationRevision(id, data, user) {
  const client = await pool.connect();
  let revisionId;
  try {
    await client.query('BEGIN');
    const quotation = await quotationForAccess(client, id, user, { lock: true, permission: 'revision' });
    if (!['Sent', 'Approved'].includes(quotation.status)) {
      throw appError('Only sent or approved quotations can be revised.', 409);
    }
    if (quotation.is_current_revision === false) throw appError('Create a revision from the current quotation.', 409);

    const groupId = quotation.revision_group_id || quotation.id;
    await client.query('SELECT pg_advisory_xact_lock($1)', [Number(groupId)]);
    const nextRevisionResult = await client.query(
      `SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number
       FROM quotations
       WHERE revision_group_id = $1 OR id = $1`,
      [groupId],
    );
    const revisionNumber = Number(nextRevisionResult.rows[0].revision_number);
    const rootNumber = String(quotation.quotation_number).replace(/-R\d+$/i, '');
    const quotationNumber = `${rootNumber}-R${revisionNumber}`;
    const reason = nullableString(data?.revision_reason, 'Revision reason', 5000)
      || nullableString(data?.negotiation_notes, 'Negotiation notes', 5000)
      || 'Customer requested a revision';

    await client.query(
      `UPDATE quotations
       SET is_current_revision = FALSE,
           status = CASE WHEN status IN ('Sent', 'Approved') THEN 'Superseded' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE revision_group_id = $1 OR id = $1`,
      [groupId],
    );

    const inserted = await client.query(
      `INSERT INTO quotations (
        quotation_number, lead_id, company_name, contact_person_name, contact_person_email,
        contact_person_phone, billing_name, billing_address, billing_city, billing_state,
        billing_pincode, billing_gstin, billing_email, billing_phone, line_items, subtotal,
        gst_rate, gst_amount, total_amount, discount_percent, discount_amount, final_price,
        payment_terms, delivery_days, warranty_terms, valid_until, status, notes,
        revision_group_id, revision_number, parent_quotation_id, is_current_revision,
        revision_reason, negotiation_notes, estimation_request_id, boq_data, costing_data,
        total_internal_cost, selling_price, margin_percent, revision_type, customer_request,
        sales_notes, technical_notes_data, prepared_by_user_id
      )
      SELECT $1, lead_id, company_name, contact_person_name, contact_person_email,
        contact_person_phone, billing_name, billing_address, billing_city, billing_state,
        billing_pincode, billing_gstin, billing_email, billing_phone, line_items, subtotal,
        gst_rate, gst_amount, total_amount, discount_percent, discount_amount, final_price,
        payment_terms, delivery_days, warranty_terms, valid_until, 'Draft', notes,
        $2, $3, id, TRUE, $4, $5, estimation_request_id, boq_data, costing_data,
        total_internal_cost, selling_price, margin_percent, 'customer_revision', $4,
        sales_notes, technical_notes_data, $6
      FROM quotations
      WHERE id = $7
      RETURNING id`,
      [quotationNumber, groupId, revisionNumber, reason, reason, user?.id || null, quotation.id],
    );
    revisionId = inserted.rows[0].id;
    await logLeadActivity(quotation.lead_id, {
      activity_type: 'system',
      content: `Quotation revision ${quotationNumber} created: ${reason}`,
      metadata: { quotation_id: revisionId, parent_quotation_id: quotation.id, revision_number: revisionNumber },
    }, user, client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return enrichedQuotation(revisionId, user);
}

async function deleteQuotation(id, user) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const quotation = await quotationForAccess(client, id, user, { lock: true, permission: 'manage' });
    if (quotation.status !== 'Draft') throw appError('Only draft quotations can be deleted.', 409);
    if (quotation.estimation_request_id) {
      throw appError('This quotation belongs to an estimation request and cannot be deleted. Revise the estimation work instead.', 409);
    }
    const linked = await client.query(
      `SELECT EXISTS (SELECT 1 FROM negotiations WHERE quotation_id = $1)
          OR EXISTS (SELECT 1 FROM crm_erp_handovers WHERE quotation_id = $1) AS linked`,
      [id],
    );
    if (linked.rows[0].linked) throw appError('This quotation has workflow history and cannot be deleted.', 409);
    const result = await client.query('DELETE FROM quotations WHERE id = $1 RETURNING id', [id]);
    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendQuotation(id, user) {
  const client = await pool.connect();
  let quotationId;
  try {
    await client.query('BEGIN');
    const quotation = await quotationForAccess(client, id, user, { lock: true, permission: 'send' });
    if (quotation.status !== 'Draft') throw appError('Only draft quotations can be sent.', 409);
    if (quotation.estimation_request_id && quotation.estimation_status !== 'returned_to_sales') {
      throw appError('Estimation must complete and return this quotation to sales before it can be sent.', 409);
    }
    const recipient = quotation.contact_person_email || quotation.billing_email;
    if (!recipient) throw appError('Add a customer email address before sending this quotation.');

    const pdf = await generateQuotationPdf(quotation, user);
    await sendEmail({
      to: recipient,
      subject: `Quotation ${quotation.quotation_number} - Vivid Electromech`,
      html: `<p>Dear ${escapeHtml(quotation.contact_person_name || 'Customer')},</p><p>Please find attached quotation <strong>${escapeHtml(quotation.quotation_number)}</strong> for ${escapeHtml(quotation.company_name)}.</p><p>Regards,<br>${escapeHtml(actorName(user) || 'Vivid Electromech')}</p>`,
      attachments: [{ filename: `${quotation.quotation_number}.pdf`, content: pdf }],
    });

    const updated = await client.query(
      `UPDATE quotations
       SET status = 'Sent',
           sent_at = CURRENT_TIMESTAMP,
           sent_by_user_id = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id`,
      [id, user?.id || null],
    );
    quotationId = updated.rows[0].id;
    await client.query(
      `UPDATE estimation_requests
       SET status = 'sent_to_client',
           sent_to_client_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE quotation_id = $1
         AND status = 'returned_to_sales'`,
      [id],
    );
    await client.query(
      `UPDATE leads
       SET quotation = $1,
           lead_status = CASE
             WHEN LOWER(lead_status) LIKE '%accept%' OR LOWER(lead_status) = 'won' THEN lead_status
             WHEN LOWER(lead_status) LIKE '%lost%' THEN lead_status
             ELSE 'Proposal Sent'
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [quotation.quotation_number, quotation.lead_id],
    );
    await logLeadActivity(quotation.lead_id, {
      activity_type: 'email',
      content: `Quotation ${quotation.quotation_number} emailed to ${recipient}`,
      metadata: { quotation_id: quotation.id, recipient },
    }, user, client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return enrichedQuotation(quotationId, user);
}

module.exports = {
  createQuotation,
  createQuotationRevision,
  deleteQuotation,
  generateQuotationDocument,
  retrieveQuotations,
  sendQuotation,
  updateQuotation,
};
