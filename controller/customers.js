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
  contact_person_email,
  billing_address,
  shipping_address,
  state,
  amc_status,
  amc_start_date,
  amc_end_date,
  total_orders,
  lifetime_value,
  customer_since,
  created_at,
  updated_at,
  source_lead_id,
  created_by_user_id,
  created_by_name,
  raw_data
`;
function actorName(user) {
  return String(user?.name || '').trim();
}

function isIndividualSales(user) {
  return ['salesperson', 'sales_engineer'].includes(String(user?.role || '').trim().toLowerCase());
}

function canAccessOwnedCustomer(customer, user) {
  if (!isIndividualSales(user)) return true;
  return String(customer?.created_by_user_id || '') === String(user?.id || '')
    || customer?.owns_linked_lead === true
    || String(customer?.sales_owner_id || '') === String(user?.id || '')
    || String(customer?.assigned_to || '').trim() === actorName(user);
}

async function customerForAccess(id, user) {
  const result = await pool.query(
    `SELECT c.id, c.created_by_user_id,
       EXISTS (
         SELECT 1 FROM leads owned
         WHERE owned.customer_id = c.id
           AND (NULLIF(to_jsonb(owned)->>'sales_owner_id', '')::BIGINT = $2 OR LOWER(TRIM(owned.assigned_to)) = LOWER(TRIM($3)))
       ) AS owns_linked_lead,
       NULLIF(to_jsonb(l)->>'sales_owner_id', '')::BIGINT AS sales_owner_id, l.assigned_to
     FROM customers c
     LEFT JOIN leads l ON l.id = c.source_lead_id
     WHERE c.id = $1`,
    [id, user?.id || null, actorName(user)],
  );
  const customer = result.rows[0];
  if (!customer) return null;
  if (!canAccessOwnedCustomer(customer, user)) {
    const error = new Error('You can access only customers from leads assigned to you.');
    error.statusCode = 403;
    throw error;
  }
  return customer;
}


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

function normalizeDate(value, field = 'Customer since') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validationError(`${field} must be a valid date in YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validationError(`${field} must be a valid date.`);
  }
  return value;
}

function effectiveAmcStatus(requestedStatus, endDate) {
  if (requestedStatus === 'None' || !endDate) return requestedStatus;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (end < today) return 'Expired';
  const dueThreshold = new Date(today);
  dueThreshold.setUTCDate(dueThreshold.getUTCDate() + 30);
  return end <= dueThreshold ? 'Due' : 'Active';
}

async function refreshAmcStatuses() {
  await pool.query(
    `UPDATE customers
     SET amc_status = CASE
       WHEN amc_end_date < CURRENT_DATE THEN 'Expired'
       WHEN amc_end_date <= CURRENT_DATE + 30 THEN 'Due'
       ELSE 'Active'
     END,
     updated_at = CURRENT_TIMESTAMP
     WHERE amc_status <> 'None'
       AND amc_end_date IS NOT NULL
       AND amc_status IS DISTINCT FROM CASE
         WHEN amc_end_date < CURRENT_DATE THEN 'Expired'
         WHEN amc_end_date <= CURRENT_DATE + 30 THEN 'Due'
         ELSE 'Active'
       END`,
  );
}

function normalizeRawData(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('Raw data must be a JSON object.');
  }
  return value;
}

function customerValues(customerData) {
  const requestedAmcStatus = customerData.amc_status || 'None';
  if (!AMC_STATUSES.has(requestedAmcStatus)) {
    throw validationError('AMC status must be None, Active, Due, or Expired.');
  }
  const amcStartDate = normalizeDate(customerData.amc_start_date, 'AMC start date');
  const amcEndDate = normalizeDate(customerData.amc_end_date, 'AMC end date');
  if (amcStartDate && amcEndDate && amcEndDate < amcStartDate) {
    throw validationError('AMC end date must be on or after the AMC start date.');
  }
  const contactEmail = nullableString(customerData.contact_person_email, 'Contact person email', 255);
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contactEmail)) {
    throw validationError('Contact person email must be valid.');
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
    contactEmail?.toLowerCase() || null,
    nullableString(customerData.billing_address, 'Billing address', 5000),
    nullableString(customerData.shipping_address, 'Shipping address', 5000),
    nullableString(customerData.state, 'State', 100),
    effectiveAmcStatus(requestedAmcStatus, amcEndDate),
    amcStartDate,
    amcEndDate,
    nonNegativeInteger(customerData.total_orders, 'Total orders'),
    nonNegativeNumber(customerData.lifetime_value, 'Lifetime value'),
    normalizeDate(customerData.customer_since, 'Customer since'),
    normalizeRawData(customerData.raw_data),
  ];
}

async function retrieveCustomers(user) {
  await refreshAmcStatuses();
  const individual = isIndividualSales(user);
  const params = individual ? [user?.id || null, actorName(user)] : [];
  const where = individual
    ? `WHERE c.created_by_user_id = $1
       OR EXISTS (
         SELECT 1 FROM leads l
         WHERE l.customer_id = c.id
           AND (NULLIF(to_jsonb(l)->>'sales_owner_id', '')::BIGINT = $1 OR LOWER(TRIM(l.assigned_to)) = LOWER(TRIM($2)))
       )`
    : '';
  const result = await pool.query(
    `SELECT ${CUSTOMER_COLUMNS}
     FROM customers c
     ${where}
     ORDER BY c.created_at DESC, c.id DESC`,
    params,
  );
  return result.rows;
}

async function searchCustomers(query) {
  const search = String(query || '').trim().slice(0, 100);
  const pattern = `%${search}%`;
  const result = await pool.query(
    `SELECT
       c.id,
       c.company_name,
       c.gstin,
       c.city,
       c.industry,
       c.segment,
       c.site_location,
       c.consultant,
       c.contact_person_name,
       c.contact_person_phone,
       COALESCE(c.contact_person_email, c.raw_data->>'contact_person_email') AS contact_person_email
     FROM customers c
     WHERE $1 = ''
        OR c.company_name ILIKE $2
        OR COALESCE(c.gstin, '') ILIKE $2
        OR COALESCE(c.city, '') ILIKE $2
        OR COALESCE(c.contact_person_name, '') ILIKE $2
     ORDER BY
       CASE
         WHEN LOWER(c.company_name) = LOWER($1) THEN 0
         WHEN LOWER(c.company_name) LIKE LOWER($1) || '%' THEN 1
         ELSE 2
       END,
       c.company_name ASC,
       c.id ASC
     LIMIT 10`,
    [search, pattern],
  );
  return result.rows;
}

async function assertUniqueCustomer(client, companyName, gstin, excludeId = null) {
  const lockKeys = [`company:${companyName.trim().toLowerCase()}`];
  if (gstin) lockKeys.push(`gstin:${gstin}`);
  lockKeys.sort();
  for (const key of lockKeys) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

  const duplicate = await client.query(
    `SELECT id, company_name
     FROM customers
     WHERE ($3::integer IS NULL OR id <> $3)
       AND (LOWER(TRIM(company_name)) = LOWER(TRIM($1))
         OR ($2::varchar IS NOT NULL AND UPPER(gstin) = UPPER($2)))
     ORDER BY id
     LIMIT 1`,
    [companyName, gstin, excludeId],
  );
  if (duplicate.rows[0]) {
    const error = new Error(`${duplicate.rows[0].company_name} already exists. Use the existing customer account.`);
    error.statusCode = 409;
    throw error;
  }
}

async function quickCreateCustomer(customerData, user) {
  const companyName = requiredString(customerData.company_name, 'Company name', 255);
  const gstin = nullableGstin(customerData.gstin, 'GSTIN');
  const contactName = requiredString(customerData.contact_person_name, 'Contact person name', 255);
  const contactPhone = nullablePhone(customerData.contact_person_phone, 'Contact person phone');
  const contactEmail = requiredString(customerData.contact_person_email, 'Contact person email', 255).toLowerCase();
  if (!contactPhone) throw validationError('Contact person phone is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    throw validationError('Contact person email must be valid.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertUniqueCustomer(client, companyName, gstin);

    const result = await client.query(
      `INSERT INTO customers (
        company_name, gstin, city, contact_person_name, contact_person_phone,
        contact_person_email, amc_status, total_orders, lifetime_value, customer_since,
        created_by_user_id, created_by_name
      ) VALUES ($1, $2, $3, $4, $5, $6, 'None', 0, 0, CURRENT_DATE, $7, $8)
      RETURNING ${CUSTOMER_COLUMNS}`,
      [
        companyName,
        gstin,
        nullableString(customerData.city, 'City', 255),
        contactName,
        contactPhone,
        contactEmail,
        user?.id || null,
        actorName(user) || null,
      ],
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function createCustomer(customerData, user) {
  if (isIndividualSales(user)) {
    const error = new Error('Customer accounts for sales users are created from their assigned leads.');
    error.statusCode = 403;
    throw error;
  }
  const values = customerValues(customerData);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertUniqueCustomer(client, values[0], values[1]);
    const result = await client.query(
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
      contact_person_email,
      billing_address,
      shipping_address,
      state,
      amc_status,
      amc_start_date,
      amc_end_date,
      total_orders,
      lifetime_value,
      customer_since,
      raw_data,
      created_by_user_id,
      created_by_name
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, COALESCE($21::date, CURRENT_DATE), $22, $23, $24)
    RETURNING ${CUSTOMER_COLUMNS}`,
      [...values, user?.id || null, actorName(user) || null],
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function updateCustomer(id, customerData, user) {
  if (!await customerForAccess(id, user)) return null;
  const values = customerValues(customerData);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertUniqueCustomer(client, values[0], values[1], Number(id));
    const result = await client.query(
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
         contact_person_email = $12,
         billing_address = $13,
         shipping_address = $14,
         state = $15,
         amc_status = $16,
         amc_start_date = $17,
         amc_end_date = $18,
         total_orders = $19,
         lifetime_value = $20,
         customer_since = COALESCE($21::date, customer_since),
         raw_data = $22,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $23
     RETURNING ${CUSTOMER_COLUMNS}`,
      [...values, id],
    );
    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function deleteCustomer(id, user) {
  if (!await customerForAccess(id, user)) return null;
  const dependencies = await pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM leads WHERE customer_id = $1) AS has_leads,
       EXISTS (SELECT 1 FROM crm_erp_handovers WHERE customer_id = $1) AS has_handovers,
       EXISTS (SELECT 1 FROM projects WHERE customer_id = $1) AS has_projects`,
    [id],
  );
  if (Object.values(dependencies.rows[0]).some(Boolean)) {
    const error = new Error('This customer has linked leads, handovers, or projects and cannot be deleted.');
    error.statusCode = 409;
    throw error;
  }
  const result = await pool.query('DELETE FROM customers WHERE id = $1 RETURNING id', [id]);
  return result.rows[0] || null;
}

async function renewAmc(id, user) {
  if (!await customerForAccess(id, user)) return null;
  const result = await pool.query(
    `UPDATE customers
     SET amc_status = 'Active',
         amc_start_date = CURRENT_DATE,
         amc_end_date = CURRENT_DATE + INTERVAL '1 year',
         updated_at = CURRENT_TIMESTAMP
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
      `SELECT id, company_name, contact_person_name, contact_person_phone, industry_type, segment, site_location, consultant, customer_id, NULLIF(to_jsonb(leads)->>'sales_owner_id', '')::BIGINT AS sales_owner_id, assigned_to
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

    if (!canAccessOwnedCustomer(lead, user)) {
      const error = new Error('You can convert only leads assigned to you.');
      error.statusCode = 403;
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
  searchCustomers,
  quickCreateCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  renewAmc,
  convertLeadToCustomer,
};
