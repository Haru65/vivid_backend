const pool = require('../config/db_connection');
const { logLeadActivity } = require('./leads');
const { sendEmail } = require('../services/emailService');
const { generateQuotationPdf } = require('../services/quotationGeneration');
const { getTaxSettings } = require('./settings');

const QUOTATION_COLUMNS = `
  id,
  quotation_number,
  lead_id,
  company_name,
  contact_person_name,
  contact_person_email,
  contact_person_phone,
  billing_name,
  billing_address,
  billing_city,
  billing_state,
  billing_pincode,
  billing_gstin,
  billing_email,
  billing_phone,
  line_items,
  subtotal,
  gst_rate,
  gst_amount,
  total_amount,
  discount_percent,
  discount_amount,
  final_price,
  payment_terms,
  delivery_days,
  warranty_terms,
  customer_po_number,
  customer_po_date,
  order_confirmed_at,
  valid_until,
  status,
  sent_at,
  notes,
  revision_group_id,
  revision_number,
  parent_quotation_id,
  is_current_revision,
  revision_reason,
  negotiation_notes,
  created_at,
  updated_at
`;

const QUOTATION_STATUSES = new Set(['Draft', 'Sent', 'Approved', 'Rejected', 'Superseded']);

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return escapeHtml(value || 'Not added');
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(amount);
}

function quotationEmailTemplate(quotation) {
  const lineItems = Array.isArray(quotation.line_items) ? quotation.line_items : [];
  const rows = lineItems.map((item) => `
    <tr>
      <td>${escapeHtml(item.description)}</td>
      <td>${escapeHtml(item.quantity)}</td>
      <td>${formatMoney(item.unit_price)}</td>
      <td>${formatMoney(item.amount || Number(item.quantity || 0) * Number(item.unit_price || 0))}</td>
    </tr>
  `).join('');

  return {
    subject: `Quotation ${quotation.quotation_number} - Vivid Electromech`,
    html:`
    <div style="font-family: Arial, sans-serif; color: #222; line-height: 1.6;">
      <p>Dear Sir/Madam,</p>

      <p>
        Please find attached our quotation for your kind review and consideration.
      </p>

      <p>
        We trust the enclosed offer is in line with your requirements. Should you require
        any clarification or further information, please feel free to contact us.
      </p>

      <p>
        We look forward to your valuable response.
      </p>

      <br />

      <p>
        Thanking you,<br />
        Yours faithfully,<br />
        <strong>Vivid Electromech Limited</strong>
      </p>
    </div>
`
  };
}

async function sendQuotationEmail(quotation, user) {
  const to = quotation.contact_person_email || quotation.billing_email;
  if (!to) throw validationError('Lead contact email or billing email is required before sending quotation.');

  const { pdf, filename } = {
    pdf: await generateQuotationPdf(quotation, user),
    filename: `${quotation.quotation_number}.pdf`,
  };
  const template = quotationEmailTemplate(quotation);
  const result = await sendEmail({
    to,
    subject: template.subject,
    html: template.html,
    attachments: [
      {
        filename,
        content: Buffer.from(pdf).toString('base64'),
      },
    ],
  });

  return {
    ...result,
    to,
    subject: template.subject,
  };
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

function nullablePhone(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length !== 10) throw validationError(`${field} must be exactly 10 digits.`);
  return digits;
}

function nullableEmail(value, field) {
  const result = nullableString(value, field, 255);
  if (!result) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(result)) throw validationError(`${field} must be a valid email address.`);
  return result;
}

function nullableGstin(value, field) {
  const result = nullableString(value, field, 15);
  if (!result) return null;
  const normalized = result.toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(normalized)) {
    throw validationError(`${field} must be a valid 15-character GSTIN.`);
  }
  return normalized;
}

function nullablePincode(value, field) {
  const result = nullableString(value, field, 6);
  if (!result) return null;
  if (!/^\d{6}$/.test(result)) throw validationError(`${field} must be exactly 6 digits.`);
  return result;
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

function nullableNonNegativeNumber(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return nonNegativeNumber(value, field);
}

function nullableInteger(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw validationError(`${field} must be a whole number of zero or more.`);
  return number;
}

function normalizeDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validationError(`${field} must use YYYY-MM-DD format.`);
  }
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
    };
  });
}

function normalizedValues(data, taxSettings = { gst_rate: 18 }) {
  const lineItems = normalizeLineItems(data.line_items);
  const subtotal = Number(lineItems.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
  const gstRate = nonNegativeNumber(data.gst_rate, 'GST rate', taxSettings.gst_rate);
  if (gstRate > 100) throw validationError('GST rate cannot exceed 100%.');
  const discountPercent = nonNegativeNumber(data.discount_percent, 'Discount', 0);
  if (discountPercent > 100) throw validationError('Discount cannot exceed 100%.');
  const discountAmount = Number((subtotal * discountPercent / 100).toFixed(2));
  const taxableAmount = Math.max(0, subtotal - discountAmount);
  const gstAmount = Number((taxableAmount * gstRate / 100).toFixed(2));
  const finalPrice = nullableNonNegativeNumber(data.final_price, 'Final price');
  const totalAmount = finalPrice === null ? Number((taxableAmount + gstAmount).toFixed(2)) : Number(finalPrice.toFixed(2));

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
    billingPincode: nullablePincode(data.billing_pincode, 'Billing pincode'),
    billingGstin: nullableGstin(data.billing_gstin, 'Billing GSTIN'),
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
    paymentTerms: nullableString(data.payment_terms, 'Payment terms', 1000),
    deliveryDays: nullableInteger(data.delivery_days, 'Delivery days'),
    warrantyTerms: nullableString(data.warranty_terms, 'Warranty terms', 1000),
    customerPoNumber: nullableString(data.customer_po_number, 'Customer PO number', 100),
    customerPoDate: normalizeDate(data.customer_po_date, 'Customer PO date'),
    validUntil: normalizeDate(data.valid_until, 'Valid until'),
    notes: nullableString(data.notes, 'Notes', 5000),
    revisionReason: nullableString(data.revision_reason, 'Revision reason', 5000),
    negotiationNotes: nullableString(data.negotiation_notes, 'Negotiation notes', 5000),
  };
}

async function retrieveQuotations() {
  const result = await pool.query(
    `SELECT ${QUOTATION_COLUMNS},
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
         WHERE n.quotation_id = quotations.id
       ), '[]'::json) AS negotiations
       , (
         SELECT json_build_object(
           'handover_id', h.id,
           'handover_number', h.handover_number,
           'handover_status', h.status,
           'project_id', p.id,
           'project_number', p.project_number,
           'project_status', p.status,
           'project_progress', p.overall_progress
         )
         FROM crm_erp_handovers h
         LEFT JOIN projects p ON p.id = h.project_id
         WHERE h.quotation_id = quotations.id
           AND h.status NOT IN ('rejected', 'cancelled')
         ORDER BY h.created_at DESC, h.id DESC
         LIMIT 1
       ) AS erp_handover
     FROM quotations
     ORDER BY created_at DESC, id DESC`,
  );
  return result.rows;
}

async function findLead(leadId) {
  const result = await pool.query(
    `SELECT id, company_name, contact_person_name, contact_person_email, contact_person_phone
     FROM leads WHERE id = $1`,
    [leadId],
  );
  return result.rows[0] || null;
}

async function generateQuotationDocument(id, user) {
  const result = await pool.query(
    `SELECT ${QUOTATION_COLUMNS},
       (SELECT assigned_to FROM leads WHERE leads.id = quotations.lead_id) AS assigned_to
     FROM quotations
     WHERE quotations.id = $1`,
    [id],
  );
  const quotation = result.rows[0];
  if (!quotation) {
    const error = new Error('Quotation not found');
    error.statusCode = 404;
    throw error;
  }

  const pdf = await generateQuotationPdf(quotation, user);
  await logLeadActivity(quotation.lead_id, {
    activity_type: 'system',
    content: `Quotation PDF generated for ${quotation.quotation_number}`,
  }, user);

  return {
    filename: `${quotation.quotation_number}.pdf`,
    pdf,
    quotation,
  };
}

async function createQuotation(data, user) {
  const taxSettings = await getTaxSettings();
  const values = normalizedValues(data, taxSettings);
  const lead = await findLead(values.leadId);
  if (!lead) {
    const error = new Error('Lead not found');
    error.statusCode = 404;
    throw error;
  }

  const sequence = await pool.query(`SELECT nextval('quotation_number_seq') AS number`);
  const quotationNumber = `QT-${String(sequence.rows[0].number).padStart(5, '0')}`;
  const result = await pool.query(
    `INSERT INTO quotations (
      quotation_number,
      lead_id,
      company_name,
      contact_person_name,
      contact_person_email,
      contact_person_phone,
      billing_name,
      billing_address,
      billing_city,
      billing_state,
      billing_pincode,
      billing_gstin,
      billing_email,
      billing_phone,
      line_items,
      subtotal,
      gst_rate,
      gst_amount,
      total_amount,
      discount_percent,
      discount_amount,
      final_price,
      payment_terms,
      delivery_days,
      warranty_terms,
      customer_po_number,
      customer_po_date,
      order_confirmed_at,
      valid_until,
      notes,
      revision_number,
      is_current_revision,
      revision_reason,
      negotiation_notes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, NULL, $28, $29, 0, TRUE, $30, $31)
    RETURNING ${QUOTATION_COLUMNS}`,
    [
      quotationNumber,
      values.leadId,
      values.companyName,
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
      values.customerPoNumber,
      values.customerPoDate,
      values.validUntil,
      values.notes,
      values.revisionReason,
      values.negotiationNotes,
    ],
  );

  const groupResult = await pool.query(
    `UPDATE quotations
     SET revision_group_id = id
     WHERE id = $1
     RETURNING ${QUOTATION_COLUMNS}`,
    [result.rows[0].id],
  );
  const quotation = groupResult.rows[0];
  await logLeadActivity(quotation.lead_id, {
    activity_type: 'system',
    content: `Quotation ${quotation.quotation_number} drafted for ${quotation.company_name}`,
  }, user);

  return quotation;
}

async function updateQuotation(id, data, user) {
  const existingResult = await pool.query(
    `SELECT id, lead_id, quotation_number
     FROM quotations
     WHERE id = $1 AND status = 'Draft'`,
    [id],
  );
  const existing = existingResult.rows[0];
  if (!existing) return null;

  const values = normalizedValues(data);
  const result = await pool.query(
    `UPDATE quotations
     SET lead_id = $1,
         company_name = $2,
         contact_person_name = $3,
         contact_person_email = $4,
         contact_person_phone = $5,
         billing_name = $6,
         billing_address = $7,
         billing_city = $8,
         billing_state = $9,
         billing_pincode = $10,
         billing_gstin = $11,
         billing_email = $12,
         billing_phone = $13,
         line_items = $14,
         subtotal = $15,
         gst_rate = $16,
         gst_amount = $17,
         total_amount = $18,
         discount_percent = $19,
         discount_amount = $20,
         final_price = $21,
         payment_terms = $22,
         delivery_days = $23,
         warranty_terms = $24,
         customer_po_number = $25,
         customer_po_date = $26,
         order_confirmed_at = CASE
           WHEN $25::varchar IS NOT NULL AND order_confirmed_at IS NULL THEN CURRENT_TIMESTAMP
           WHEN $25::varchar IS NULL THEN NULL
           ELSE order_confirmed_at
         END,
         valid_until = $27,
         notes = $28,
         revision_reason = $29,
         negotiation_notes = $30,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $31 AND status = 'Draft'
     RETURNING ${QUOTATION_COLUMNS}`,
    [
      values.leadId,
      values.companyName,
      values.contactPersonName,
      values.contactPersonEmail,
      values.contactPersonPhone,
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
      values.customerPoNumber,
      values.customerPoDate,
      values.validUntil,
      values.notes,
      values.revisionReason,
      values.negotiationNotes,
      id,
    ],
  );

  const quotation = result.rows[0] || null;
  if (!quotation) return null;

  const activity = {
    activity_type: 'system',
    content: `Quotation ${quotation.quotation_number} draft updated`,
  };
  await logLeadActivity(quotation.lead_id, activity, user);
  if (String(existing.lead_id) !== String(quotation.lead_id)) {
    await logLeadActivity(existing.lead_id, {
      activity_type: 'system',
      content: `Quotation ${quotation.quotation_number} moved to another lead`,
    }, user);
  }

  return quotation;
}

async function deleteQuotation(id, user) {
  const client = await pool.connect();
  let quotation = null;
  let restored = null;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `DELETE FROM quotations
       WHERE id = $1 AND status = 'Draft'
       RETURNING id, lead_id, quotation_number, revision_group_id, revision_number`,
      [id],
    );
    quotation = result.rows[0] || null;
    if (!quotation) {
      await client.query('ROLLBACK');
      return null;
    }

    if (quotation.revision_group_id && Number(quotation.revision_number) > 0) {
      const restoredResult = await client.query(
        `UPDATE quotations
         SET is_current_revision = TRUE,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = (
           SELECT id
           FROM quotations
           WHERE revision_group_id = $1
           ORDER BY revision_number DESC, id DESC
           LIMIT 1
         )
         RETURNING id, lead_id, quotation_number, status`,
        [quotation.revision_group_id],
      );
      restored = restoredResult.rows[0] || null;
      if (restored) {
        await client.query(
          `UPDATE leads
           SET quotation = $1,
               lead_status = CASE
                 WHEN LOWER(lead_status) LIKE '%accept%' OR LOWER(lead_status) = 'won' THEN lead_status
                 WHEN LOWER(lead_status) LIKE '%lost%' THEN lead_status
                 WHEN $3 = 'Sent' THEN 'Proposal Sent'
                 ELSE lead_status
               END
           WHERE id = $2`,
          [restored.quotation_number, restored.lead_id, restored.status],
        );
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await logLeadActivity(quotation.lead_id, {
    activity_type: 'system',
    content: `Quotation ${quotation.quotation_number} draft deleted`,
  }, user);
  if (restored) {
    await logLeadActivity(restored.lead_id, {
      activity_type: 'system',
      content: `Quotation ${restored.quotation_number} restored as current revision`,
    }, user);
  }

  return quotation;
}

function baseQuotationNumber(quotationNumber) {
  return String(quotationNumber || '').replace(/-R\d+$/i, '');
}

async function createQuotationRevision(id, data = {}, user) {
  const client = await pool.connect();
  let revision = null;
  let source = null;
  try {
    await client.query('BEGIN');
    const sourceResult = await client.query(
      `SELECT ${QUOTATION_COLUMNS}
       FROM quotations
       WHERE id = $1
       FOR UPDATE`,
      [id],
    );
    source = sourceResult.rows[0];
    if (!source) {
      const error = new Error('Quotation not found');
      error.statusCode = 404;
      throw error;
    }
    if (source.status !== 'Sent') {
      const error = new Error('Only sent quotations can be revised.');
      error.statusCode = 400;
      throw error;
    }

    const groupId = source.revision_group_id || source.id;
    const draftResult = await client.query(
      `SELECT id, quotation_number
       FROM quotations
       WHERE revision_group_id = $1 AND status = 'Draft'
       ORDER BY revision_number DESC
       LIMIT 1`,
      [groupId],
    );
    if (draftResult.rows[0]) {
      const error = new Error(`Draft revision ${draftResult.rows[0].quotation_number} already exists.`);
      error.statusCode = 400;
      throw error;
    }

    const maxResult = await client.query(
      `SELECT COALESCE(MAX(revision_number), 0) AS max_revision
       FROM quotations
       WHERE revision_group_id = $1`,
      [groupId],
    );
    const nextRevision = Number(maxResult.rows[0].max_revision || 0) + 1;

    const originalResult = await client.query(
      `SELECT quotation_number
       FROM quotations
       WHERE revision_group_id = $1 AND revision_number = 0
       ORDER BY id
       LIMIT 1`,
      [groupId],
    );
    const quotationNumber = `${baseQuotationNumber(originalResult.rows[0]?.quotation_number || source.quotation_number)}-R${nextRevision}`;
    const revisionReason = nullableString(data.revision_reason, 'Revision reason', 5000)
      || 'Negotiation requested by lead';
    const negotiationNotes = nullableString(data.negotiation_notes, 'Negotiation notes', 5000)
      || source.negotiation_notes
      || null;

    await client.query(
      `UPDATE quotations
       SET is_current_revision = FALSE,
           updated_at = CURRENT_TIMESTAMP
       WHERE revision_group_id = $1`,
      [groupId],
    );

    const revisionResult = await client.query(
      `INSERT INTO quotations (
        quotation_number,
        lead_id,
        company_name,
        contact_person_name,
        contact_person_email,
        contact_person_phone,
        billing_name,
        billing_address,
        billing_city,
        billing_state,
        billing_pincode,
        billing_gstin,
        billing_email,
        billing_phone,
        line_items,
        subtotal,
        gst_rate,
        gst_amount,
        total_amount,
        discount_percent,
        discount_amount,
        final_price,
        payment_terms,
        delivery_days,
        warranty_terms,
        customer_po_number,
        customer_po_date,
        order_confirmed_at,
        valid_until,
        status,
        notes,
        revision_group_id,
        revision_number,
        parent_quotation_id,
        is_current_revision,
        revision_reason,
        negotiation_notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, NULL, $28, 'Draft', $29, $30, $31, $32, TRUE, $33, $34)
      RETURNING ${QUOTATION_COLUMNS}`,
      [
        quotationNumber,
        source.lead_id,
        source.company_name,
        source.contact_person_name,
        source.contact_person_email,
        source.contact_person_phone,
        source.billing_name,
        source.billing_address,
        source.billing_city,
        source.billing_state,
        source.billing_pincode,
        source.billing_gstin,
        source.billing_email,
        source.billing_phone,
        JSON.stringify(source.line_items || []),
        source.subtotal,
        source.gst_rate,
        source.gst_amount,
        source.total_amount,
        source.discount_percent,
        source.discount_amount,
        source.final_price,
        source.payment_terms,
        source.delivery_days,
        source.warranty_terms,
        source.customer_po_number,
        source.customer_po_date,
        source.valid_until,
        source.notes,
        groupId,
        nextRevision,
        source.id,
        revisionReason,
        negotiationNotes,
      ],
    );

    await client.query(
      `UPDATE leads
       SET quotation = $1,
           lead_status = 'Negotiation'
       WHERE id = $2`,
      [quotationNumber, source.lead_id],
    );

    revision = revisionResult.rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await logLeadActivity(revision.lead_id, {
    activity_type: 'system',
    content: `Negotiation started; revision ${revision.quotation_number} drafted from ${source.quotation_number}`,
  }, user);

  return revision;
}

async function sendQuotation(id, user) {
  const client = await pool.connect();
  let updatedQuotation = null;
  let supersededQuotations = [];
  let emailResult = null;
  try {
    await client.query('BEGIN');
    const quotationResult = await client.query(
      `SELECT ${QUOTATION_COLUMNS} FROM quotations WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const quotation = quotationResult.rows[0];
    if (!quotation) {
      const error = new Error('Quotation not found');
      error.statusCode = 404;
      throw error;
    }
    if (quotation.status !== 'Draft') {
      const error = new Error('Only draft quotations can be sent.');
      error.statusCode = 400;
      throw error;
    }

    emailResult = await sendQuotationEmail(quotation, user);

    const groupId = quotation.revision_group_id || quotation.id;
    await client.query(
      `UPDATE quotations
       SET is_current_revision = FALSE,
           updated_at = CURRENT_TIMESTAMP
       WHERE revision_group_id = $1 AND id <> $2`,
      [groupId, id],
    );

    const supersededResult = await client.query(
      `UPDATE quotations
       SET status = 'Superseded',
           updated_at = CURRENT_TIMESTAMP
       WHERE revision_group_id = $1
         AND id <> $2
         AND status = 'Sent'
       RETURNING quotation_number`,
      [groupId, id],
    );
    supersededQuotations = supersededResult.rows;

    const updatedResult = await client.query(
      `UPDATE quotations
       SET status = 'Sent',
           sent_at = CURRENT_TIMESTAMP,
           revision_group_id = $2,
           is_current_revision = TRUE,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING ${QUOTATION_COLUMNS}`,
      [id, groupId],
    );

    await client.query(
      `UPDATE leads
       SET quotation = $1,
           lead_status = CASE
             WHEN LOWER(lead_status) LIKE '%accept%' OR LOWER(lead_status) = 'won' THEN lead_status
             WHEN LOWER(lead_status) LIKE '%lost%' THEN lead_status
             WHEN $3::int > 0 THEN 'Negotiation'
             ELSE 'Proposal Sent'
           END
       WHERE id = $2`,
      [quotation.quotation_number, quotation.lead_id, quotation.revision_number || 0],
    );

    updatedQuotation = updatedResult.rows[0];

    await client.query('COMMIT');

    await logLeadActivity(updatedQuotation.lead_id, {
      activity_type: 'email',
      content: `${updatedQuotation.revision_number > 0 ? 'Revision' : 'Quotation'} ${updatedQuotation.quotation_number} emailed to ${emailResult.to}`,
      metadata: {
        quotation_id: updatedQuotation.id,
        quotation_number: updatedQuotation.quotation_number,
        email_to: emailResult.to,
        email_subject: emailResult.subject,
        email_provider_id: emailResult.id,
      },
    }, user);
    await Promise.all(supersededQuotations.map((item) => logLeadActivity(updatedQuotation.lead_id, {
      activity_type: 'system',
      content: `Quotation ${item.quotation_number} marked superseded`,
    }, user)));

    return updatedQuotation;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  retrieveQuotations,
  createQuotation,
  createQuotationRevision,
  updateQuotation,
  deleteQuotation,
  sendQuotation,
  generateQuotationDocument,
};
