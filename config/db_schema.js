const pool = require('./db_connection');
const { createUserSchema } = require('../controller/userManagement');

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

async function createLeadActivitySchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_activities (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER NOT NULL,
      activity_type VARCHAR(20) NOT NULL DEFAULT 'note'
        CHECK (activity_type IN ('note', 'call', 'whatsapp', 'system', 'email', 'meeting', 'negotiation', 'approval_requested', 'approval')),
      content TEXT NOT NULL,
      actor_name VARCHAR(255) NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE lead_activities
    ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
  `);

  await pool.query(`
    ALTER TABLE lead_activities
    DROP CONSTRAINT IF EXISTS lead_activities_activity_type_check;
  `);

  await pool.query(`
    ALTER TABLE lead_activities
    ADD CONSTRAINT lead_activities_activity_type_check
    CHECK (activity_type IN ('note', 'call', 'whatsapp', 'system', 'email', 'meeting', 'negotiation', 'approval_requested', 'approval'));
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS lead_activities_lead_id_idx
    ON lead_activities (lead_id, created_at DESC);
  `);

  console.log('Lead activity schema created successfully.');
}

async function createLeadFollowupSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_followups (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER NOT NULL,
      followup_type VARCHAR(30) NOT NULL DEFAULT 'General'
        CHECK (followup_type IN ('Call', 'WhatsApp', 'Email', 'Meeting', 'Payment', 'Quotation', 'General')),
      title VARCHAR(255) NOT NULL,
      notes TEXT,
      due_at TIMESTAMPTZ NOT NULL,
      priority VARCHAR(20) NOT NULL DEFAULT 'Medium'
        CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent')),
      status VARCHAR(20) NOT NULL DEFAULT 'Open'
        CHECK (status IN ('Open', 'Completed', 'Cancelled')),
      assigned_to VARCHAR(255),
      completed_at TIMESTAMPTZ,
      created_by VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS lead_followups_lead_due_idx
    ON lead_followups (lead_id, due_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS lead_followups_status_due_idx
    ON lead_followups (status, due_at);
  `);

  console.log('Lead followup schema created successfully.');
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
      discount_percent NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
      discount_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
      final_price NUMERIC(14, 2),
      payment_terms TEXT,
      delivery_days INTEGER,
      warranty_terms TEXT,
      customer_po_number VARCHAR(100),
      customer_po_date DATE,
      order_confirmed_at TIMESTAMPTZ,
      valid_until DATE,
      status VARCHAR(20) NOT NULL DEFAULT 'Draft'
        CHECK (status IN ('Draft', 'Sent', 'Approved', 'Rejected', 'Superseded')),
      sent_at TIMESTAMP,
      notes TEXT,
      revision_group_id INTEGER,
      revision_number INTEGER NOT NULL DEFAULT 0 CHECK (revision_number >= 0),
      parent_quotation_id INTEGER,
      is_current_revision BOOLEAN NOT NULL DEFAULT TRUE,
      revision_reason TEXT,
      negotiation_notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE quotations
    ADD COLUMN IF NOT EXISTS revision_group_id INTEGER,
    ADD COLUMN IF NOT EXISTS revision_number INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS parent_quotation_id INTEGER,
    ADD COLUMN IF NOT EXISTS is_current_revision BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS revision_reason TEXT,
    ADD COLUMN IF NOT EXISTS negotiation_notes TEXT,
    ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS final_price NUMERIC(14, 2),
    ADD COLUMN IF NOT EXISTS payment_terms TEXT,
    ADD COLUMN IF NOT EXISTS delivery_days INTEGER,
    ADD COLUMN IF NOT EXISTS warranty_terms TEXT,
    ADD COLUMN IF NOT EXISTS customer_po_number VARCHAR(100),
    ADD COLUMN IF NOT EXISTS customer_po_date DATE,
    ADD COLUMN IF NOT EXISTS order_confirmed_at TIMESTAMPTZ;
  `);

  await pool.query(`
    ALTER TABLE quotations
    DROP CONSTRAINT IF EXISTS quotations_status_check;
  `);

  await pool.query(`
    ALTER TABLE quotations
    ADD CONSTRAINT quotations_status_check
    CHECK (status IN ('Draft', 'Sent', 'Approved', 'Rejected', 'Superseded'));
  `);

  await pool.query(`
    UPDATE quotations
    SET revision_group_id = id
    WHERE revision_group_id IS NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS quotations_lead_id_idx
    ON quotations (lead_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS quotations_status_idx
    ON quotations (status);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS quotations_revision_group_idx
    ON quotations (revision_group_id, revision_number DESC);
  `);

  console.log('Quotation schema created successfully.');
}

async function createNegotiationApprovalSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id SERIAL PRIMARY KEY,
      module VARCHAR(50) NOT NULL,
      record_id INTEGER NOT NULL,
      approval_type VARCHAR(50) NOT NULL,
      requested_by_name VARCHAR(255) NOT NULL,
      requested_by_role VARCHAR(100),
      approver_name VARCHAR(255),
      approver_role VARCHAR(100),
      status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'changes_requested', 'cancelled')),
      reason TEXT,
      comments TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_at TIMESTAMPTZ,
      rejected_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS negotiations (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER,
      quotation_id INTEGER NOT NULL,
      negotiation_type VARCHAR(50) NOT NULL,
      old_value TEXT,
      proposed_value TEXT NOT NULL,
      reason TEXT,
      requested_by_name VARCHAR(255) NOT NULL,
      requested_by_role VARCHAR(100),
      requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
      approval_request_id INTEGER,
      status VARCHAR(30) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'pending_approval', 'approved', 'rejected', 'applied', 'cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS negotiation_authority_rules (
      id SERIAL PRIMARY KEY,
      role_name VARCHAR(100) NOT NULL,
      negotiation_type VARCHAR(50) NOT NULL,
      max_numeric_value NUMERIC(14, 2),
      is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      requires_ga_above_limit BOOLEAN NOT NULL DEFAULT TRUE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS negotiation_authority_rules_active_unique
    ON negotiation_authority_rules (LOWER(role_name), negotiation_type)
    WHERE active = TRUE;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS negotiations_quotation_idx
    ON negotiations (quotation_id, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS approval_requests_status_idx
    ON approval_requests (status, requested_at DESC);
  `);

  await pool.query(`
    INSERT INTO negotiation_authority_rules (role_name, negotiation_type, max_numeric_value, is_allowed, requires_ga_above_limit)
    VALUES
      ('salesperson', 'discount', 3, TRUE, TRUE),
      ('salesperson', 'final_price', 3, TRUE, TRUE),
      ('salesperson', 'payment_terms', 30, TRUE, TRUE),
      ('salesperson', 'delivery_extension', 5, TRUE, TRUE),
      ('salesperson', 'warranty', 12, TRUE, TRUE),
      ('salesperson', 'other', NULL, FALSE, TRUE),
      ('admin', 'discount', 100, TRUE, TRUE),
      ('admin', 'final_price', 100, TRUE, TRUE),
      ('admin', 'payment_terms', 365, TRUE, TRUE),
      ('admin', 'delivery_extension', 365, TRUE, TRUE),
      ('admin', 'warranty', 120, TRUE, TRUE),
      ('admin', 'other', NULL, TRUE, FALSE)
    ON CONFLICT DO NOTHING;
  `);

  console.log('Negotiation approval schema created successfully.');
}

async function createHandoverProjectSchema() {
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS handover_number_seq;
  `);

  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS project_number_seq;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_erp_handovers (
      id SERIAL PRIMARY KEY,
      handover_number VARCHAR(50) UNIQUE NOT NULL,
      customer_id INTEGER NOT NULL,
      lead_id INTEGER,
      quotation_id INTEGER NOT NULL,
      sales_order_id INTEGER,
      status VARCHAR(30) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'ready', 'submitted', 'accepted', 'rejected', 'project_created', 'cancelled')),
      project_name VARCHAR(255),
      priority VARCHAR(30) NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
      requested_delivery_date DATE,
      commercial_notes TEXT,
      technical_notes TEXT,
      internal_notes TEXT,
      customer_po_number VARCHAR(100),
      customer_po_date DATE,
      snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      submitted_by_name VARCHAR(255),
      submitted_by_role VARCHAR(100),
      submitted_at TIMESTAMPTZ,
      accepted_by_name VARCHAR(255),
      accepted_by_role VARCHAR(100),
      accepted_at TIMESTAMPTZ,
      rejected_by_name VARCHAR(255),
      rejected_by_role VARCHAR(100),
      rejected_at TIMESTAMPTZ,
      rejection_reason TEXT,
      project_id INTEGER,
      created_by_name VARCHAR(255),
      created_by_role VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      project_number VARCHAR(50) UNIQUE NOT NULL,
      handover_id INTEGER UNIQUE,
      customer_id INTEGER NOT NULL,
      lead_id INTEGER,
      quotation_id INTEGER,
      sales_order_id INTEGER,
      project_name VARCHAR(255) NOT NULL,
      customer_po_number VARCHAR(100),
      order_value NUMERIC(14, 2),
      order_date DATE,
      planned_start_date DATE,
      promised_delivery_date DATE,
      project_manager_name VARCHAR(255),
      priority VARCHAR(30) NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
      status VARCHAR(40) NOT NULL DEFAULT 'handover'
        CHECK (status IN ('handover', 'engineering', 'bom_preparation', 'procurement', 'planning', 'production', 'quality', 'ready_for_dispatch', 'dispatched', 'completed', 'on_hold', 'cancelled')),
      overall_progress NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (overall_progress >= 0 AND overall_progress <= 100),
      handover_snapshot JSONB,
      created_by_name VARCHAR(255),
      created_by_role VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS handovers_quotation_idx
    ON crm_erp_handovers (quotation_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS handovers_sales_order_idx
    ON crm_erp_handovers (sales_order_id)
    WHERE sales_order_id IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS handovers_status_idx
    ON crm_erp_handovers (status, created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS handovers_project_idx
    ON crm_erp_handovers (project_id)
    WHERE project_id IS NOT NULL;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS handovers_active_quotation_unique
    ON crm_erp_handovers (quotation_id)
    WHERE status NOT IN ('rejected', 'cancelled');
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS handovers_active_sales_order_unique
    ON crm_erp_handovers (sales_order_id)
    WHERE sales_order_id IS NOT NULL
      AND status NOT IN ('rejected', 'cancelled');
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS projects_customer_idx
    ON projects (customer_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS projects_status_idx
    ON projects (status, created_at DESC);
  `);

  console.log('Handover and project schema created successfully.');
}

async function createMeetingSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meetings (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      meeting_type VARCHAR(30) NOT NULL DEFAULT 'Meeting',
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      all_day BOOLEAN NOT NULL DEFAULT FALSE,
      status VARCHAR(20) NOT NULL DEFAULT 'Scheduled'
        CHECK (status IN ('Scheduled', 'Completed', 'Cancelled')),
      owner_name VARCHAR(255) NOT NULL,
      location VARCHAR(255),
      lead_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT meetings_time_range_check CHECK (end_at > start_at)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS meetings_start_at_idx
    ON meetings (start_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS meetings_owner_name_idx
    ON meetings (owner_name);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS meetings_lead_id_idx
    ON meetings (lead_id);
  `);

  console.log('Meeting schema created successfully.');
}

async function createSettingsSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key VARCHAR(100) PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    INSERT INTO system_settings (key, value)
    VALUES ('tax_rates', '{"gst_rate": 18, "cgst_rate": 9, "sgst_rate": 9}'::jsonb)
    ON CONFLICT (key) DO NOTHING;
  `);

  console.log('Settings schema created successfully.');
}

async function createSchemas() {
  await createUserSchema();
  try {
    await createLeadSchema();
  } catch (error) {
    // Existing deployments may use a database role that can query leads but
    // cannot alter the table. Customer bootstrap can still proceed safely.
    if (error.code !== '42501') throw error;
    console.warn('Skipping lead schema migration because the database role is not the leads table owner.');
  }
  await createLeadActivitySchema();
  await createLeadFollowupSchema();
  await createCustomerSchema();
  await createQuotationSchema();
  await createMeetingSchema();
  await createSettingsSchema();
  await createNegotiationApprovalSchema();
  await createHandoverProjectSchema();
}

module.exports = { createUserSchema, createLeadSchema, createLeadActivitySchema, createLeadFollowupSchema, createCustomerSchema, createQuotationSchema, createMeetingSchema, createSettingsSchema, createNegotiationApprovalSchema, createHandoverProjectSchema, createSchemas };
