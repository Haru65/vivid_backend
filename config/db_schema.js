const pool = require('./db_connection');

async function createLeadSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      company_name VARCHAR(255) NOT NULL,
      contact_person_name VARCHAR(255) NOT NULL,
      contact_person_email VARCHAR(255) NOT NULL,
      contact_person_phone VARCHAR(20) NOT NULL,
      quotation VARCHAR(255),
      lead_source VARCHAR(255) NOT NULL,
      lead_status VARCHAR(50) NOT NULL,
      requirements_summary TEXT,
      assigned_to VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      raw_data JSONB
    );
  `);

  // CREATE TABLE IF NOT EXISTS does not add columns to an existing table.
  await pool.query(`
    ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS quotation VARCHAR(255);
  `);

  console.log('Lead schema created successfully.');
}

async function createCustomerSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      company_name VARCHAR(255) NOT NULL,
      gstin VARCHAR(20),
      city VARCHAR(255),
      contact_person_name VARCHAR(255),
      contact_person_phone VARCHAR(20),
      amc_status VARCHAR(20) NOT NULL DEFAULT 'None'
        CHECK (amc_status IN ('None', 'Active', 'Due', 'Expired')),
      total_orders INTEGER NOT NULL DEFAULT 0 CHECK (total_orders >= 0),
      lifetime_value NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (lifetime_value >= 0),
      customer_since DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- Kept as an application-managed reference because the deployment role
      -- may not have REFERENCES privilege on the existing leads table.
      source_lead_id INTEGER,
      raw_data JSONB
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS customers_company_name_idx
    ON customers (LOWER(company_name));
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS customers_amc_status_idx
    ON customers (amc_status);
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS customers_source_lead_id_idx
    ON customers (source_lead_id)
    WHERE source_lead_id IS NOT NULL;
  `);

  console.log('Customer schema created successfully.');
}

async function createQuotationSchema() {
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS quotation_number_seq;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quotations (
      id SERIAL PRIMARY KEY,
      quotation_number VARCHAR(50) NOT NULL UNIQUE,
      lead_id INTEGER NOT NULL,
      company_name VARCHAR(255) NOT NULL,
      contact_person_name VARCHAR(255),
      contact_person_email VARCHAR(255),
      contact_person_phone VARCHAR(20),
      billing_name VARCHAR(255) NOT NULL,
      billing_address TEXT NOT NULL,
      billing_city VARCHAR(255),
      billing_state VARCHAR(255),
      billing_pincode VARCHAR(20),
      billing_gstin VARCHAR(20),
      billing_email VARCHAR(255),
      billing_phone VARCHAR(20),
      line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
      subtotal NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
      gst_rate NUMERIC(5, 2) NOT NULL DEFAULT 18 CHECK (gst_rate >= 0 AND gst_rate <= 100),
      gst_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (gst_amount >= 0),
      total_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
      valid_until DATE,
      status VARCHAR(20) NOT NULL DEFAULT 'Draft'
        CHECK (status IN ('Draft', 'Sent', 'Approved', 'Rejected')),
      sent_at TIMESTAMP,
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS quotations_lead_id_idx
    ON quotations (lead_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS quotations_status_idx
    ON quotations (status);
  `);

  console.log('Quotation schema created successfully.');
}

async function createSchemas() {
  try {
    await createLeadSchema();
  } catch (error) {
    // Existing deployments may use a database role that can query leads but
    // cannot alter the table. Customer bootstrap can still proceed safely.
    if (error.code !== '42501') throw error;
    console.warn('Skipping lead schema migration because the database role is not the leads table owner.');
  }
  await createCustomerSchema();
  await createQuotationSchema();
}

module.exports = { createLeadSchema, createCustomerSchema, createQuotationSchema, createSchemas };
