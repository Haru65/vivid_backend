const pool = require('../config/db_connection');
const { logLeadActivity } = require('./leads');

const CUSTOMER_COLUMNS = `
  id,
  company_name,
  gstin,
  city,
  company_type,
  industry,
  company_site,
  segment,
  site_location,
  consultant,
  contact_person_name,
  contact_person_phone,
  amc_status,
  total_orders,
  lifetime_value,
  customer_since,
  created_at,
  updated_at,
  source_lead_id,
  raw_data
`;

const AMC_STATUSES = new Set(['None', 'Active', 'Due', 'Expired']);

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function nullableString(value, field, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw validationError(`${field} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) throw validationError(`${field} is too long.`);
  return trimmed;
}

function requiredString(value, field, maxLength) {
  const result = nullableString(value, field, maxLength);
  if (!result) throw validationError(`${field} is required.`);
  return result;
}

function nullablePhone(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length !== 10) throw validationError(`${field} must be exactly 10 digits.`);
  return digits;
}

function nullableGstin(value, field) {
  const gstin = nullableString(value, field, 15);
  if (!gstin) return null;
  const normalized = gstin.toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(normalized)) {
    throw validationError(`${field} must be a valid 15-character GSTIN.`);
  }
  return normalized;
}

function nonNegativeNumber(value, field, defaultValue = 0) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw validationError(`${field} must be a non-negative number.`);
  }
  return number;
}

function nonNegativeInteger(value, field, defaultValue = 0) {
  const number = nonNegativeNumber(value, field, defaultValue);
  if (!Number.isInteger(number)) throw validationError(`${field} must be a whole number.`);
  return number;
}

function normalizeDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validationError('Customer since must be a valid date in YYYY-MM-DD format.');
  }
  return value;
}

function normalizeRawData(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('Raw data must be a JSON object.');
  }
  return value;
}

function customerValues(customerData) {
  const amcStatus = customerData.amc_status || 'None';
  if (!AMC_STATUSES.has(amcStatus)) {
    throw validationError('AMC status must be None, Active, Due, or Expired.');
  }

  return [
    requiredString(customerData.company_name, 'Company name', 255),
    nullableGstin(customerData.gstin, 'GSTIN'),
    nullableString(customerData.city, 'City', 255),
    nullableString(customerData.company_type, 'Company type', 100),
    nullableString(customerData.industry, 'Industry', 100),
    nullableString(customerData.company_site, 'Company site', 255),
    nullableString(customerData.segment, 'Segment', 100),
    nullableString(customerData.site_location, 'Site location', 255),
    nullableString(customerData.consultant, 'Consultant', 255),
    nullableString(customerData.contact_person_name, 'Contact person name', 255),
    nullablePhone(customerData.contact_person_phone, 'Contact person phone'),
    amcStatus,
    nonNegativeInteger(customerData.total_orders, 'Total orders'),
    nonNegativeNumber(customerData.lifetime_value, 'Lifetime value'),
    normalizeDate(customerData.customer_since),
    normalizeRawData(customerData.raw_data),
  ];
}

async function retrieveCustomers() {
  const result = await pool.query(
    `SELECT ${CUSTOMER_COLUMNS}
     FROM customers
     ORDER BY created_at DESC, id DESC`,
  );
  return result.rows;
}

async function createCustomer(customerData) {
  const result = await pool.query(
    `INSERT INTO customers (
      company_name,
      gstin,
      city,
      company_type,
      industry,
      company_site,
      segment,
      site_location,
      consultant,
      contact_person_name,
      contact_person_phone,
      amc_status,
      total_orders,
      lifetime_value,
      customer_since,
      raw_data
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE($15::date, CURRENT_DATE), $16)
    RETURNING ${CUSTOMER_COLUMNS}`,
    customerValues(customerData),
  );

  return result.rows[0];
}

async function updateCustomer(id, customerData) {
  const result = await pool.query(
    `UPDATE customers
     SET company_name = $1,
         gstin = $2,
         city = $3,
         company_type = $4,
         industry = $5,
         company_site = $6,
         segment = $7,
         site_location = $8,
         consultant = $9,
         contact_person_name = $10,
         contact_person_phone = $11,
         amc_status = $12,
         total_orders = $13,
         lifetime_value = $14,
         customer_since = COALESCE($15::date, customer_since),
         raw_data = $16,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $17
     RETURNING ${CUSTOMER_COLUMNS}`,
    [...customerValues(customerData), id],
  );

  return result.rows[0] || null;
}

async function deleteCustomer(id) {
  const result = await pool.query(
    `DELETE FROM customers WHERE id = $1 RETURNING id`,
    [id],
  );

  return result.rows[0] || null;
}

async function renewAmc(id) {
  const result = await pool.query(
    `UPDATE customers
     SET amc_status = 'Active', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING ${CUSTOMER_COLUMNS}`,
    [id],
  );

  return result.rows[0] || null;
}

async function convertLeadToCustomer(leadId, user) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const leadResult = await client.query(
      `SELECT id, company_name, contact_person_name, contact_person_phone, industry_type, segment, site_location, consultant, customer_id
       FROM leads
       WHERE id = $1
       FOR SHARE`,
      [leadId],
    );

    const lead = leadResult.rows[0];
    if (!lead) {
      const error = new Error('Lead not found');
      error.statusCode = 404;
      throw error;
    }

    const existingResult = await client.query(
      `SELECT ${CUSTOMER_COLUMNS}
       FROM customers
       WHERE source_lead_id = $1
          OR id = $3
          OR LOWER(company_name) = LOWER($2)
       ORDER BY CASE WHEN source_lead_id = $1 THEN 0 WHEN id = $3 THEN 1 ELSE 2 END, id
       LIMIT 1`,
      [lead.id, lead.company_name, lead.customer_id],
    );

    if (existingResult.rows[0]) {
      await client.query('UPDATE leads SET customer_id = $1 WHERE id = $2', [existingResult.rows[0].id, lead.id]);
      await client.query('COMMIT');
      await logLeadActivity(lead.id, {
        activity_type: 'system',
        content: `Customer conversion checked; ${existingResult.rows[0].company_name} already exists`,
      }, user);
      return { customer: existingResult.rows[0], created: false };
    }

    const customerResult = await client.query(
      `INSERT INTO customers (
        company_name,
        industry,
        segment,
        site_location,
        consultant,
        contact_person_name,
        contact_person_phone,
        amc_status,
        customer_since,
        source_lead_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'None', CURRENT_DATE, $8)
      RETURNING ${CUSTOMER_COLUMNS}`,
      [
        lead.company_name,
        lead.industry_type || null,
        lead.segment || null,
        lead.site_location || null,
        lead.consultant || null,
        lead.contact_person_name || null,
        lead.contact_person_phone || null,
        lead.id,
      ],
    );

    await client.query('UPDATE leads SET customer_id = $1 WHERE id = $2', [customerResult.rows[0].id, lead.id]);

    await client.query('COMMIT');
    await logLeadActivity(lead.id, {
      activity_type: 'system',
      content: `Lead converted to customer account ${customerResult.rows[0].company_name}`,
    }, user);
    return { customer: customerResult.rows[0], created: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  retrieveCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  renewAmc,
  convertLeadToCustomer,
};
