const pool = require('../config/db_connection');

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
  valid_until,
  status,
  sent_at,
  notes,
  created_at,
  updated_at
`;

const QUOTATION_STATUSES = new Set(['Draft', 'Sent', 'Approved', 'Rejected']);

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
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

function normalizedValues(data) {
  const lineItems = normalizeLineItems(data.line_items);
  const subtotal = Number(lineItems.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
  const gstRate = nonNegativeNumber(data.gst_rate, 'GST rate', 18);
  if (gstRate > 100) throw validationError('GST rate cannot exceed 100%.');
  const gstAmount = Number((subtotal * gstRate / 100).toFixed(2));
  const totalAmount = Number((subtotal + gstAmount).toFixed(2));

  return {
    leadId: positiveInteger(data.lead_id, 'Lead'),
    companyName: requiredString(data.company_name, 'Company name', 255),
    contactPersonName: nullableString(data.contact_person_name, 'Contact person name', 255),
    contactPersonEmail: nullableString(data.contact_person_email, 'Contact person email', 255),
    contactPersonPhone: nullableString(data.contact_person_phone, 'Contact person phone', 20),
    billingName: requiredString(data.billing_name, 'Billing name', 255),
    billingAddress: requiredString(data.billing_address, 'Billing address', 5000),
    billingCity: nullableString(data.billing_city, 'Billing city', 255),
    billingState: nullableString(data.billing_state, 'Billing state', 255),
    billingPincode: nullableString(data.billing_pincode, 'Billing pincode', 20),
    billingGstin: nullableString(data.billing_gstin, 'Billing GSTIN', 20),
    billingEmail: nullableString(data.billing_email, 'Billing email', 255),
    billingPhone: nullableString(data.billing_phone, 'Billing phone', 20),
    lineItems,
    subtotal,
    gstRate,
    gstAmount,
    totalAmount,
    validUntil: normalizeDate(data.valid_until, 'Valid until'),
    notes: nullableString(data.notes, 'Notes', 5000),
  };
}

async function retrieveQuotations() {
  const result = await pool.query(
    `SELECT ${QUOTATION_COLUMNS}
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

async function createQuotation(data) {
  const values = normalizedValues(data);
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
      valid_until,
      notes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
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
      values.validUntil,
      values.notes,
    ],
  );

  return result.rows[0];
}

async function updateQuotation(id, data) {
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
         valid_until = $19,
         notes = $20,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $21 AND status = 'Draft'
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
      values.validUntil,
      values.notes,
      id,
    ],
  );

  return result.rows[0] || null;
}

async function deleteQuotation(id) {
  const result = await pool.query(
    `DELETE FROM quotations WHERE id = $1 AND status = 'Draft' RETURNING id`,
    [id],
  );
  return result.rows[0] || null;
}

async function sendQuotation(id) {
  const client = await pool.connect();
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

    const updatedResult = await client.query(
      `UPDATE quotations
       SET status = 'Sent', sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING ${QUOTATION_COLUMNS}`,
      [id],
    );

    await client.query(
      `UPDATE leads
       SET quotation = $1,
           lead_status = CASE
             WHEN LOWER(lead_status) LIKE '%accept%' OR LOWER(lead_status) = 'won' THEN lead_status
             WHEN LOWER(lead_status) LIKE '%lost%' THEN lead_status
             ELSE 'Proposal Sent'
           END
       WHERE id = $2`,
      [quotation.quotation_number, quotation.lead_id],
    );

    await client.query('COMMIT');
    return updatedResult.rows[0];
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
  updateQuotation,
  deleteQuotation,
  sendQuotation,
};
