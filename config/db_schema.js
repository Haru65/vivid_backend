const pool = require('./db_connection');
const { createUserSchema } = require('../controller/userManagement');

async function createLeadSchema() {
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS enquiry_number_seq;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      enquiry_number VARCHAR(50) UNIQUE,
      company_name VARCHAR(255) NOT NULL,
      project_name VARCHAR(255),
      contact_person_name VARCHAR(255) NOT NULL,
      contact_person_email VARCHAR(255) NOT NULL,
      contact_person_phone VARCHAR(20) NOT NULL,
      enquiry_date DATE NOT NULL,
      enquiry_state VARCHAR(20) NOT NULL DEFAULT 'Purchase'
        CHECK (enquiry_state IN ('Purchase', 'Tender', 'Budget')),
      sales_approval_status VARCHAR(30) NOT NULL DEFAULT 'Vivid Not Approved'
        CHECK (sales_approval_status IN ('Vivid Approved', 'Vivid Not Approved', 'OEM Approved')),
      priority VARCHAR(20) NOT NULL DEFAULT 'Medium'
        CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent')),
      customer_id INTEGER,
      segment VARCHAR(100),
      site_location VARCHAR(255),
      billing_state VARCHAR(255),
      billing_district VARCHAR(255),
      billing_city VARCHAR(255),
      billing_pincode VARCHAR(6),
      precise_location TEXT,
      consultant VARCHAR(255),
      enquiry_product TEXT,
      enquiry_notes TEXT,
      industry_type VARCHAR(100),
      quotation VARCHAR(255),
      lead_source VARCHAR(255) NOT NULL,
      lead_status VARCHAR(50) NOT NULL,
      loss_reason VARCHAR(255),
      hold_reason TEXT,
      drop_reason TEXT,
      status_before_hold VARCHAR(50),
      held_at TIMESTAMPTZ,
      dropped_at TIMESTAMPTZ,
      requirements_summary TEXT,
      assigned_to VARCHAR(255),
      sales_owner_id BIGINT,
      current_stage VARCHAR(50) NOT NULL DEFAULT 'enquiry',
      current_assignee_id BIGINT,
      current_department VARCHAR(100) NOT NULL DEFAULT 'Sales',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_data JSONB
    );
  `);

  // CREATE TABLE IF NOT EXISTS does not add columns to an existing table.
  await pool.query(`
    ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS project_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS quotation VARCHAR(255),
    ADD COLUMN IF NOT EXISTS enquiry_date DATE NOT NULL DEFAULT CURRENT_DATE,
    ADD COLUMN IF NOT EXISTS enquiry_state VARCHAR(20) NOT NULL DEFAULT 'Purchase',
    ADD COLUMN IF NOT EXISTS sales_approval_status VARCHAR(30) NOT NULL DEFAULT 'Vivid Not Approved',
    ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'Medium',
    ADD COLUMN IF NOT EXISTS customer_id INTEGER,
    ADD COLUMN IF NOT EXISTS segment VARCHAR(100),
    ADD COLUMN IF NOT EXISTS site_location VARCHAR(255),
    ADD COLUMN IF NOT EXISTS billing_state VARCHAR(255),
    ADD COLUMN IF NOT EXISTS billing_district VARCHAR(255),
    ADD COLUMN IF NOT EXISTS billing_city VARCHAR(255),
    ADD COLUMN IF NOT EXISTS billing_pincode VARCHAR(6),
    ADD COLUMN IF NOT EXISTS precise_location TEXT,
    ADD COLUMN IF NOT EXISTS consultant VARCHAR(255),
    ADD COLUMN IF NOT EXISTS enquiry_product TEXT,
    ADD COLUMN IF NOT EXISTS enquiry_notes TEXT,
    ADD COLUMN IF NOT EXISTS industry_type VARCHAR(100),
    ADD COLUMN IF NOT EXISTS enquiry_number VARCHAR(50),
    ADD COLUMN IF NOT EXISTS loss_reason VARCHAR(255),
    ADD COLUMN IF NOT EXISTS hold_reason TEXT,
    ADD COLUMN IF NOT EXISTS drop_reason TEXT,
    ADD COLUMN IF NOT EXISTS status_before_hold VARCHAR(50),
    ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS dropped_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sales_owner_id BIGINT,
    ADD COLUMN IF NOT EXISTS current_stage VARCHAR(50) NOT NULL DEFAULT 'enquiry',
    ADD COLUMN IF NOT EXISTS current_assignee_id BIGINT,
    ADD COLUMN IF NOT EXISTS current_department VARCHAR(100) NOT NULL DEFAULT 'Sales',
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;


  `);

  

  await pool.query(`
    ALTER TABLE leads
    DROP CONSTRAINT IF EXISTS leads_enquiry_state_check;
    ALTER TABLE leads
    ADD CONSTRAINT leads_enquiry_state_check
    CHECK (enquiry_state IN ('Purchase', 'Tender', 'Budget'));
  `);

  await pool.query(`
    ALTER TABLE leads
    DROP CONSTRAINT IF EXISTS leads_sales_approval_status_check;
    UPDATE leads
    SET sales_approval_status = CASE
      WHEN sales_approval_status IN ('ABB Approval', 'OEM') THEN 'OEM Approved'
      WHEN sales_approval_status = 'Not Vivid Approved' THEN 'Vivid Not Approved'
      ELSE sales_approval_status
    END;
    ALTER TABLE leads
    ALTER COLUMN sales_approval_status SET DEFAULT 'Vivid Not Approved';
    ALTER TABLE leads
    ADD CONSTRAINT leads_sales_approval_status_check
    CHECK (sales_approval_status IN ('Vivid Approved', 'Vivid Not Approved', 'OEM Approved'));
  `);

  await pool.query(`
    UPDATE leads
    SET enquiry_number = 'ENQ-' || TO_CHAR(COALESCE(enquiry_date, created_at::date, CURRENT_DATE), 'YYYY') || '-' || LPAD(id::text, 5, '0')
    WHERE enquiry_number IS NULL;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS leads_enquiry_number_idx ON leads (enquiry_number);
    CREATE INDEX IF NOT EXISTS leads_customer_id_idx ON leads (customer_id);
    CREATE INDEX IF NOT EXISTS leads_current_work_idx ON leads (current_assignee_id, current_stage, updated_at DESC);
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
      actor_user_id BIGINT,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE lead_activities
    ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS actor_user_id BIGINT;
  `);

  await pool.query(`
    UPDATE lead_activities a
    SET actor_user_id = (
      SELECT u.id
      FROM users u
      WHERE LOWER(TRIM(CONCAT_WS(' ', u.first_name, u.last_name))) = LOWER(TRIM(a.actor_name))
      ORDER BY u.id ASC
      LIMIT 1
    )
    WHERE a.actor_user_id IS NULL
      AND NULLIF(TRIM(a.actor_name), '') IS NOT NULL;
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

  await pool.query(`
    CREATE INDEX IF NOT EXISTS lead_activities_audit_idx
    ON lead_activities (created_at DESC, activity_type, actor_user_id);
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
      assigned_to_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      assigned_to VARCHAR(255),
      completed_at TIMESTAMPTZ,
      completion_latitude NUMERIC(10, 7),
      completion_longitude NUMERIC(10, 7),
      completion_accuracy_m NUMERIC(10, 2),
      location_captured_at TIMESTAMPTZ,
      created_by VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE lead_followups
    ADD COLUMN IF NOT EXISTS assigned_to_user_id BIGINT,
    ADD COLUMN IF NOT EXISTS completion_latitude NUMERIC(10, 7),
    ADD COLUMN IF NOT EXISTS completion_longitude NUMERIC(10, 7),
    ADD COLUMN IF NOT EXISTS completion_accuracy_m NUMERIC(10, 2),
    ADD COLUMN IF NOT EXISTS location_captured_at TIMESTAMPTZ;
  `);

  await pool.query(`
    UPDATE lead_followups f
    SET assigned_to_user_id = (
      SELECT u.id
      FROM users u
      WHERE u.is_active = TRUE
        AND LOWER(TRIM(CONCAT_WS(' ', u.first_name, u.last_name))) = LOWER(TRIM(f.assigned_to))
      ORDER BY u.id ASC
      LIMIT 1
    )
    WHERE f.assigned_to_user_id IS NULL
      AND NULLIF(TRIM(f.assigned_to), '') IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS lead_followups_lead_due_idx
    ON lead_followups (lead_id, due_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS lead_followups_status_due_idx
    ON lead_followups (status, due_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS lead_followups_assignee_status_due_idx
    ON lead_followups (assigned_to_user_id, status, due_at);
  `);

  console.log('Lead followup schema created successfully.');
}

async function createCustomerSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      company_name VARCHAR(255) NOT NULL,
      gstin VARCHAR(20),
      pan VARCHAR(10),
      city VARCHAR(255),
      country VARCHAR(100) NOT NULL DEFAULT 'India',
      state VARCHAR(100),
      district VARCHAR(255),
      pincode VARCHAR(6),
      precise_location TEXT,
      company_type VARCHAR(100),
      industry VARCHAR(100),
      company_site VARCHAR(255),
      segment VARCHAR(100),
      site_location VARCHAR(255),
      consultant VARCHAR(255),
      contact_person_name VARCHAR(255),
      designation VARCHAR(255),
      contact_person_phone VARCHAR(20),
      contact_person_email VARCHAR(255),
      alternate_contact_name VARCHAR(255),
      alternate_contact_phone VARCHAR(20),
      alternate_contact_email VARCHAR(255),
      billing_address TEXT,
      shipping_address TEXT,
      amc_status VARCHAR(20) NOT NULL DEFAULT 'None'
        CHECK (amc_status IN ('None', 'Active', 'Due', 'Expired')),
      amc_start_date DATE,
      amc_end_date DATE,
      total_orders INTEGER NOT NULL DEFAULT 0 CHECK (total_orders >= 0),
      lifetime_value NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (lifetime_value >= 0),
      customer_since DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- Kept as an application-managed reference because the deployment role
      -- may not have REFERENCES privilege on the existing leads table.
      source_lead_id INTEGER,
      created_by_user_id BIGINT,
      created_by_name VARCHAR(255),
      account_owner_user_id BIGINT,
      account_owner_name VARCHAR(255),
      remarks TEXT,
      region VARCHAR(100),
      raw_data JSONB
    );
  `);

  await pool.query(`
    ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS company_type VARCHAR(100),
    ADD COLUMN IF NOT EXISTS pan VARCHAR(10),
    ADD COLUMN IF NOT EXISTS country VARCHAR(100) NOT NULL DEFAULT 'India',
    ADD COLUMN IF NOT EXISTS district VARCHAR(255),
    ADD COLUMN IF NOT EXISTS pincode VARCHAR(6),
    ADD COLUMN IF NOT EXISTS precise_location TEXT,
    ADD COLUMN IF NOT EXISTS industry VARCHAR(100),
    ADD COLUMN IF NOT EXISTS company_site VARCHAR(255),
    ADD COLUMN IF NOT EXISTS segment VARCHAR(100),
    ADD COLUMN IF NOT EXISTS site_location VARCHAR(255),
    ADD COLUMN IF NOT EXISTS consultant VARCHAR(255),
    ADD COLUMN IF NOT EXISTS contact_person_email VARCHAR(255),
    ADD COLUMN IF NOT EXISTS designation VARCHAR(255),
    ADD COLUMN IF NOT EXISTS alternate_contact_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS alternate_contact_phone VARCHAR(20),
    ADD COLUMN IF NOT EXISTS alternate_contact_email VARCHAR(255),
    ADD COLUMN IF NOT EXISTS billing_address TEXT,
    ADD COLUMN IF NOT EXISTS shipping_address TEXT,
    ADD COLUMN IF NOT EXISTS state VARCHAR(100),
    ADD COLUMN IF NOT EXISTS amc_start_date DATE,
    ADD COLUMN IF NOT EXISTS amc_end_date DATE,
    ADD COLUMN IF NOT EXISTS created_by_user_id BIGINT,
    ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS account_owner_user_id BIGINT,
    ADD COLUMN IF NOT EXISTS account_owner_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS remarks TEXT,
    ADD COLUMN IF NOT EXISTS region VARCHAR(100);
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
    CREATE INDEX IF NOT EXISTS customers_account_owner_idx
    ON customers (account_owner_user_id, updated_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS customers_amc_end_date_idx
    ON customers (amc_end_date)
    WHERE amc_end_date IS NOT NULL;
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
      estimation_request_id INTEGER,
      boq_data JSONB NOT NULL DEFAULT '[]'::jsonb,
      costing_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      total_internal_cost NUMERIC(14, 2),
      selling_price NUMERIC(14, 2),
      margin_percent NUMERIC(7, 2),
      revision_type VARCHAR(50),
      customer_request TEXT,
      sales_notes TEXT,
      technical_notes_data JSONB NOT NULL DEFAULT '[]'::jsonb,
      prepared_by_user_id BIGINT,
      reviewed_by_user_id BIGINT,
      sent_by_user_id BIGINT,
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
    ADD COLUMN IF NOT EXISTS estimation_request_id INTEGER,
    ADD COLUMN IF NOT EXISTS prepared_by_user_id BIGINT,
    ADD COLUMN IF NOT EXISTS reviewed_by_user_id BIGINT,
    ADD COLUMN IF NOT EXISTS sent_by_user_id BIGINT,
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
    ADD COLUMN IF NOT EXISTS boq_data JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS costing_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS total_internal_cost NUMERIC(14, 2),
    ADD COLUMN IF NOT EXISTS selling_price NUMERIC(14, 2),
    ADD COLUMN IF NOT EXISTS margin_percent NUMERIC(7, 2),
    ADD COLUMN IF NOT EXISTS revision_type VARCHAR(50),
    ADD COLUMN IF NOT EXISTS customer_request TEXT,
    ADD COLUMN IF NOT EXISTS sales_notes TEXT,
    ADD COLUMN IF NOT EXISTS technical_notes_data JSONB NOT NULL DEFAULT '[]'::jsonb;
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
      requested_by_user_id BIGINT,
      requested_by_role VARCHAR(100),
      approver_name VARCHAR(255),
      approver_user_id BIGINT,
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
    ALTER TABLE approval_requests
    ADD COLUMN IF NOT EXISTS requested_by_user_id BIGINT,
    ADD COLUMN IF NOT EXISTS approver_user_id BIGINT;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS approval_requests_requester_user_idx
    ON approval_requests (requested_by_user_id, requested_at DESC);
    CREATE INDEX IF NOT EXISTS approval_requests_approver_user_idx
    ON approval_requests (approver_user_id, requested_at DESC);
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
      created_by_user_id BIGINT,
      created_by_name VARCHAR(255),
      created_by_role VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE crm_erp_handovers
    ADD COLUMN IF NOT EXISTS created_by_user_id BIGINT;
  `);

  await pool.query(`
    UPDATE crm_erp_handovers h
    SET created_by_user_id = u.id
    FROM users u
    WHERE h.created_by_user_id IS NULL
      AND LOWER(TRIM(h.created_by_name)) = LOWER(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)))
      AND 1 = (
        SELECT COUNT(*)
        FROM users candidate
        WHERE LOWER(TRIM(CONCAT_WS(' ', candidate.first_name, candidate.last_name))) = LOWER(TRIM(h.created_by_name))
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
    CREATE TABLE IF NOT EXISTS project_stage_tasks (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL,
      stage_number INTEGER NOT NULL,
      stage_key VARCHAR(80) NOT NULL,
      stage_name VARCHAR(255) NOT NULL,
      department VARCHAR(100),
      description TEXT,
      sequence_index INTEGER NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'completed', 'blocked', 'skipped')),
      checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
      notes TEXT,
      assigned_to VARCHAR(255),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      completed_by VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (project_id, stage_key)
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
    CREATE INDEX IF NOT EXISTS handovers_created_by_user_idx
    ON crm_erp_handovers (created_by_user_id, created_at DESC);
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

  await pool.query(`
    CREATE INDEX IF NOT EXISTS project_stage_tasks_project_idx
    ON project_stage_tasks (project_id, sequence_index);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS project_stage_tasks_status_idx
    ON project_stage_tasks (status, stage_number);
  `);

  console.log('Handover and project schema created successfully.');
}



async function createNotificationSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id SERIAL PRIMARY KEY,
      recipient_user_id BIGINT,
      recipient_name VARCHAR(255),
      title VARCHAR(255) NOT NULL,
      body TEXT,
      category VARCHAR(50) NOT NULL DEFAULT 'general',
      link_type VARCHAR(50),
      link_id INTEGER,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    UPDATE user_notifications n
    SET recipient_user_id = (
      SELECT u.id
      FROM users u
      WHERE u.is_active = TRUE
        AND LOWER(TRIM(CONCAT_WS(' ', u.first_name, u.last_name))) = LOWER(TRIM(n.recipient_name))
      ORDER BY u.id ASC
      LIMIT 1
    )
    WHERE n.recipient_user_id IS NULL
      AND NULLIF(TRIM(n.recipient_name), '') IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS user_notifications_recipient_idx
    ON user_notifications (recipient_user_id, recipient_name, read_at, created_at DESC);
  `);

  console.log('Notification schema created successfully.');
}

async function createEstimationRequestSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS estimation_requests (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER NOT NULL,
      customer_id INTEGER,
      quotation_id INTEGER,
      requested_by_user_id BIGINT,
      requested_by_name VARCHAR(255) NOT NULL,
      sales_owner_id BIGINT,
      sales_owner_name VARCHAR(255),
      sales_head_id BIGINT,
      estimation_head_id BIGINT,
      estimation_head_name VARCHAR(255),
      assigned_engineer_id BIGINT,
      assigned_engineer_name VARCHAR(255),
      current_stage VARCHAR(50) NOT NULL DEFAULT 'estimation_submitted',
      current_assignee_id BIGINT,
      status VARCHAR(50) NOT NULL DEFAULT 'submitted'
        CHECK (status IN ('submitted', 'assigned', 'in_progress', 'submitted_for_review', 'revision_requested', 'revision_requested_by_sales', 'revision_in_progress', 'revision_submitted_for_review', 'approved', 'returned_to_sales', 'sent_to_client', 'client_approved', 'discarded', 'on_hold', 'dropped', 'po_sales_draft', 'po_submitted_to_estimation', 'po_estimation_in_progress', 'po_submitted_to_head', 'po_approved_by_estimation_head', 'cancelled')),
      segment VARCHAR(100),
      project_name VARCHAR(255),
      site_location VARCHAR(255),
      consultant VARCHAR(255),
      enquiry_product TEXT,
      enquiry_notes TEXT,
      requirements_summary TEXT,
      assignment_notes TEXT,
      review_notes TEXT,
      revision_notes TEXT,
      hold_reason TEXT,
      drop_reason TEXT,
      status_before_hold VARCHAR(50),
      held_at TIMESTAMPTZ,
      dropped_at TIMESTAMPTZ,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      assigned_at TIMESTAMPTZ,
      engineer_started_at TIMESTAMPTZ,
      engineer_submitted_at TIMESTAMPTZ,
      head_approved_at TIMESTAMPTZ,
      returned_to_sales_at TIMESTAMPTZ,
      sent_to_client_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE estimation_requests
    ADD COLUMN IF NOT EXISTS customer_id INTEGER,
    ADD COLUMN IF NOT EXISTS project_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS quotation_id INTEGER,
    ADD COLUMN IF NOT EXISTS requested_by_user_id BIGINT,
    ADD COLUMN IF NOT EXISTS sales_owner_id BIGINT,
    ADD COLUMN IF NOT EXISTS sales_head_id BIGINT,
    ADD COLUMN IF NOT EXISTS estimation_head_id BIGINT,
    ADD COLUMN IF NOT EXISTS assignment_notes TEXT,
    ADD COLUMN IF NOT EXISTS review_notes TEXT,
    ADD COLUMN IF NOT EXISTS revision_notes TEXT,
    ADD COLUMN IF NOT EXISTS hold_reason TEXT,
    ADD COLUMN IF NOT EXISTS drop_reason TEXT,
    ADD COLUMN IF NOT EXISTS status_before_hold VARCHAR(50),
    ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS dropped_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS current_stage VARCHAR(50) NOT NULL DEFAULT 'estimation_submitted',
    ADD COLUMN IF NOT EXISTS current_assignee_id BIGINT;
  `);



  await pool.query(`
    ALTER TABLE estimation_requests
    DROP CONSTRAINT IF EXISTS estimation_requests_status_check;
  `);

  await pool.query(`UPDATE estimation_requests SET status = 'submitted_for_review' WHERE status = 'pending_md_approval';`);

  await pool.query(`
    ALTER TABLE estimation_requests
    ADD CONSTRAINT estimation_requests_status_check
    CHECK (status IN ('submitted', 'assigned', 'in_progress', 'submitted_for_review', 'revision_requested', 'revision_requested_by_sales', 'revision_in_progress', 'revision_submitted_for_review', 'approved', 'returned_to_sales', 'sent_to_client', 'client_approved', 'discarded', 'on_hold', 'dropped', 'po_sales_draft', 'po_submitted_to_estimation', 'po_estimation_in_progress', 'po_submitted_to_head', 'po_approved_by_estimation_head', 'cancelled'));
  `);

  await pool.query(`
    ALTER TABLE estimation_requests
    ADD COLUMN IF NOT EXISTS revision_requested_by VARCHAR(50),
    ADD COLUMN IF NOT EXISTS client_decision VARCHAR(50),
    ADD COLUMN IF NOT EXISTS discard_reason TEXT,
    ADD COLUMN IF NOT EXISTS po_closure_sheet_id INTEGER;
  `);

  await pool.query(`
    DROP INDEX IF EXISTS estimation_requests_open_lead_idx;
    CREATE UNIQUE INDEX estimation_requests_open_lead_idx
    ON estimation_requests (lead_id)
    WHERE status NOT IN ('cancelled', 'discarded', 'dropped', 'sent_to_client');
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS estimation_requests_status_idx
    ON estimation_requests (status, updated_at DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS estimation_quote_uploads (
      id SERIAL PRIMARY KEY,
      estimation_request_id INTEGER NOT NULL UNIQUE,
      quotation_number VARCHAR(80) UNIQUE,
      revision_number INTEGER NOT NULL DEFAULT 0,
      filename VARCHAR(255) NOT NULL,
      mime_type VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
      file_size INTEGER NOT NULL CHECK (file_size > 0),
      quote_value NUMERIC(14, 2) NOT NULL CHECK (quote_value > 0),
      pdf_data BYTEA NOT NULL,
      uploaded_by_user_id BIGINT,
      uploaded_by_name VARCHAR(255) NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE estimation_quote_uploads
    ADD COLUMN IF NOT EXISTS quotation_number VARCHAR(80),
    ADD COLUMN IF NOT EXISTS revision_number INTEGER NOT NULL DEFAULT 0;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS estimation_quote_uploads_number_idx
    ON estimation_quote_uploads (quotation_number)
    WHERE quotation_number IS NOT NULL;
  `);

  await pool.query(`
    UPDATE lead_activities AS activity
    SET content = REPLACE(activity.content, upload.filename, upload.quotation_number)
    FROM estimation_requests AS request
    JOIN estimation_quote_uploads AS upload
      ON upload.estimation_request_id = request.id
    WHERE activity.lead_id = request.lead_id
      AND activity.activity_type = 'system'
      AND upload.quotation_number IS NOT NULL
      AND POSITION(upload.filename IN activity.content) > 0;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS estimation_quote_uploads_request_idx
    ON estimation_quote_uploads (estimation_request_id);
  `);

  console.log('Estimation request schema created successfully.');
}


async function createPoClosureSheetSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS po_closure_sheets (
      id SERIAL PRIMARY KEY,
      estimation_request_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      quotation_id INTEGER,
      customer_id INTEGER,
      status VARCHAR(50) NOT NULL DEFAULT 'sales_draft'
        CHECK (status IN ('sales_draft', 'submitted_to_estimation', 'estimation_in_progress', 'submitted_to_head', 'approved_by_estimation_head')),
      sales_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      estimation_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      sales_submitted_by_user_id BIGINT,
      sales_submitted_by_name VARCHAR(255),
      sales_submitted_at TIMESTAMPTZ,
      estimation_filled_by_user_id BIGINT,
      estimation_filled_by_name VARCHAR(255),
      estimation_filled_at TIMESTAMPTZ,
      head_approved_by_user_id BIGINT,
      head_approved_by_name VARCHAR(255),
      head_approved_at TIMESTAMPTZ,
      approval_required BOOLEAN NOT NULL DEFAULT FALSE,
      approval_requested_by_user_id BIGINT,
      approval_requested_by_name VARCHAR(255),
      approval_requested_at TIMESTAMPTZ,
      md_approval_status VARCHAR(20),
      md_decided_by_user_id BIGINT,
      md_decided_by_name VARCHAR(255),
      md_decided_at TIMESTAMPTZ,
      md_decision_comments TEXT,
      order_finalized_by_user_id BIGINT,
      order_finalized_by_name VARCHAR(255),
      order_finalized_at TIMESTAMPTZ,
      changes_requested_by_user_id BIGINT,
      changes_requested_by_name VARCHAR(255),
      changes_requested_at TIMESTAMPTZ,
      changes_requested_reason TEXT,
      ready_for_erp_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE po_closure_sheets
    ADD COLUMN IF NOT EXISTS changes_requested_by_user_id BIGINT,
    ADD COLUMN IF NOT EXISTS changes_requested_by_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS changes_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS changes_requested_reason TEXT,
    ADD COLUMN IF NOT EXISTS ready_for_erp_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS approval_required BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS approval_requested_by_user_id BIGINT,
    ADD COLUMN IF NOT EXISTS approval_requested_by_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS approval_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS md_approval_status VARCHAR(20),
    ADD COLUMN IF NOT EXISTS md_decided_by_user_id BIGINT,
    ADD COLUMN IF NOT EXISTS md_decided_by_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS md_decided_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS md_decision_comments TEXT,
    ADD COLUMN IF NOT EXISTS order_finalized_by_user_id BIGINT,
    ADD COLUMN IF NOT EXISTS order_finalized_by_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS order_finalized_at TIMESTAMPTZ;
  `);

  await pool.query(`
    ALTER TABLE po_closure_sheets DROP CONSTRAINT IF EXISTS po_closure_sheets_status_check;
    ALTER TABLE po_closure_sheets ADD CONSTRAINT po_closure_sheets_status_check
      CHECK (status IN ('sales_draft', 'submitted_to_estimation', 'estimation_in_progress', 'submitted_to_head', 'changes_requested', 'approved_by_estimation_head', 'ready_for_erp'));
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS po_closure_sheets_request_idx
    ON po_closure_sheets (estimation_request_id);
  `);

  console.log('PO closure sheet schema created successfully.');
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
      owner_user_id BIGINT,
      location VARCHAR(255),
      lead_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT meetings_time_range_check CHECK (end_at > start_at)
    );
  `);

  await pool.query(`
    ALTER TABLE meetings
    ADD COLUMN IF NOT EXISTS owner_user_id BIGINT;
  `);

  await pool.query(`
    UPDATE meetings m
    SET owner_user_id = u.id
    FROM users u
    WHERE m.owner_user_id IS NULL
      AND LOWER(TRIM(m.owner_name)) = LOWER(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)))
      AND u.is_active = TRUE
      AND 1 = (
        SELECT COUNT(*)
        FROM users candidate
        WHERE candidate.is_active = TRUE
          AND LOWER(TRIM(CONCAT_WS(' ', candidate.first_name, candidate.last_name))) = LOWER(TRIM(m.owner_name))
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
    CREATE INDEX IF NOT EXISTS meetings_owner_user_id_idx
    ON meetings (owner_user_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS meetings_lead_id_idx
    ON meetings (lead_id);
  `);

  console.log('Meeting schema created successfully.');
}

async function createVisitTaskSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visit_tasks (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      client_name VARCHAR(255) NOT NULL,
      company_name VARCHAR(255) NOT NULL,
      contact_number VARCHAR(30),
      location VARCHAR(500) NOT NULL,
      reason_for_visit TEXT NOT NULL,
      meeting_at TIMESTAMPTZ NOT NULL,
      all_day BOOLEAN NOT NULL DEFAULT FALSE,
      review TEXT,
      remark TEXT,
      next_activity TEXT,
      completion_latitude NUMERIC(10, 7),
      completion_longitude NUMERIC(10, 7),
      completion_accuracy_m NUMERIC(10, 2),
      completed_at TIMESTAMPTZ,
      priority VARCHAR(20) NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'todo'
        CHECK (status IN ('todo', 'in_progress', 'completed', 'cancelled')),
      created_by_user_id BIGINT NOT NULL,
      created_by_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE visit_tasks
    ADD COLUMN IF NOT EXISTS review TEXT,
    ADD COLUMN IF NOT EXISTS remark TEXT,
    ADD COLUMN IF NOT EXISTS next_activity TEXT,
    ADD COLUMN IF NOT EXISTS completion_latitude NUMERIC(10, 7),
    ADD COLUMN IF NOT EXISTS completion_longitude NUMERIC(10, 7),
    ADD COLUMN IF NOT EXISTS completion_accuracy_m NUMERIC(10, 2),
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'normal',
    ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS all_day BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await pool.query(`
    ALTER TABLE visit_tasks DROP CONSTRAINT IF EXISTS visit_tasks_priority_check;
    ALTER TABLE visit_tasks ADD CONSTRAINT visit_tasks_priority_check
      CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS visit_tasks_meeting_at_idx ON visit_tasks (meeting_at);
    CREATE INDEX IF NOT EXISTS visit_tasks_status_idx ON visit_tasks (status);
    CREATE INDEX IF NOT EXISTS visit_tasks_created_by_idx ON visit_tasks (created_by_user_id);
    CREATE INDEX IF NOT EXISTS visit_tasks_planning_idx ON visit_tasks (created_by_user_id, sort_order, meeting_at);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_planning_reminders (
      id SERIAL PRIMARY KEY,
      recipient_user_id BIGINT NOT NULL,
      week_start DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (recipient_user_id, week_start)
    );
  `);

  console.log('Visit task schema created successfully.');
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

async function createLeadChangeRequestSchema(db = pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS lead_change_requests (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER NOT NULL,
      company_name VARCHAR(255) NOT NULL,
      requested_by_user_id BIGINT NOT NULL,
      requested_by_name VARCHAR(255) NOT NULL,
      sales_head_id BIGINT,
      estimation_head_id BIGINT NOT NULL,
      before_snapshot JSONB NOT NULL,
      proposed_snapshot JSONB NOT NULL,
      changes JSONB NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'pending_md_approval', 'applied', 'rejected', 'conflict')),
      sales_approved_at TIMESTAMPTZ,
      estimation_approved_at TIMESTAMPTZ,
      sales_comments TEXT,
      estimation_comments TEXT,
      rejected_by_user_id BIGINT,
      rejection_reason TEXT,
      md_approval_requested_by_user_id BIGINT,
      md_approval_requested_by_name VARCHAR(255),
      md_approval_requested_at TIMESTAMPTZ,
      md_decided_by_user_id BIGINT,
      md_decided_by_name VARCHAR(255),
      md_decided_at TIMESTAMPTZ,
      md_comments TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMPTZ,
      CHECK (sales_head_id <> estimation_head_id),
      CHECK (requested_by_user_id <> sales_head_id AND requested_by_user_id <> estimation_head_id)
    );
    CREATE INDEX IF NOT EXISTS lead_change_requests_review_idx
      ON lead_change_requests (sales_head_id, estimation_head_id, status, created_at DESC);
  `);
  await db.query(`
    ALTER TABLE lead_change_requests ALTER COLUMN sales_head_id DROP NOT NULL;
    ALTER TABLE lead_change_requests ALTER COLUMN status TYPE VARCHAR(30);
    ALTER TABLE lead_change_requests DROP CONSTRAINT IF EXISTS lead_change_requests_status_check;
    ALTER TABLE lead_change_requests ADD CONSTRAINT lead_change_requests_status_check
      CHECK (status IN ('pending', 'pending_md_approval', 'applied', 'rejected', 'conflict'));
    ALTER TABLE lead_change_requests
      ADD COLUMN IF NOT EXISTS md_approval_requested_by_user_id BIGINT,
      ADD COLUMN IF NOT EXISTS md_approval_requested_by_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS md_approval_requested_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS md_decided_by_user_id BIGINT,
      ADD COLUMN IF NOT EXISTS md_decided_by_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS md_decided_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS md_comments TEXT;
    DROP INDEX IF EXISTS lead_change_requests_pending_lead_idx;
    CREATE UNIQUE INDEX lead_change_requests_pending_lead_idx
      ON lead_change_requests (lead_id) WHERE status IN ('pending', 'pending_md_approval');
  `);
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
  await createVisitTaskSchema();
  await createSettingsSchema();
  await createNegotiationApprovalSchema();
  await createNotificationSchema();
  await createEstimationRequestSchema();
  await createPoClosureSheetSchema();
  await createHandoverProjectSchema();
  await createLeadChangeRequestSchema();
}

module.exports = { createUserSchema, createLeadSchema, createLeadActivitySchema, createLeadFollowupSchema, createCustomerSchema, createQuotationSchema, createNotificationSchema, createEstimationRequestSchema, createPoClosureSheetSchema, createMeetingSchema, createVisitTaskSchema, createSettingsSchema, createNegotiationApprovalSchema, createHandoverProjectSchema, createLeadChangeRequestSchema, createSchemas };
