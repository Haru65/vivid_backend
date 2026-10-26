const assert = require('node:assert/strict');
const test = require('node:test');

// Opt in with RUN_LEAD_CHANGE_DB_TEST=1. All writes use connection-local TEMP
// tables; application tables and their sequences are never written to.
test('PostgreSQL: submission, dual approval, logs, notification targeting and stale conflict', {
  skip: process.env.RUN_LEAD_CHANGE_DB_TEST !== '1',
}, async () => {
  const pool = require('../config/db_connection');
  const { createLeadChangeRequestSchema } = require('../config/db_schema');
  const { updateLead } = require('../controller/leads');
  const { listLeadChanges, reviewLeadChange } = require('../services/leadChangeService');
  const client = await pool.connect();
  const db = { query: client.query.bind(client), release() {} };
  const deps = { pool: { connect: async () => db } };
  try {
    await client.query(`
      CREATE TEMP TABLE users (id BIGINT PRIMARY KEY, first_name TEXT, last_name TEXT, role TEXT, is_active BOOLEAN);
      INSERT INTO users VALUES (1, 'Sales', 'Engineer', 'sales_engineer', TRUE), (2, 'Sales', 'Head', 'sales_head', TRUE),
        (3, 'Estimation', 'Head', 'estimation_head', TRUE), (4, 'Estimation', 'Engineer', 'estimation_engineer', TRUE),
        (5, 'Unrelated', 'Engineer', 'estimation_engineer', TRUE), (6, 'Other', 'Head', 'sales_head', TRUE),
        (7, 'Other', 'Salesperson', 'sales_engineer', TRUE);
      CREATE TEMP TABLE leads (
        id INTEGER PRIMARY KEY, company_name TEXT, project_name TEXT, contact_person_name TEXT,
        contact_person_email TEXT, contact_person_phone TEXT, enquiry_date DATE, enquiry_state TEXT,
        sales_approval_status TEXT, priority TEXT, customer_id INTEGER, segment TEXT, site_location TEXT,
        billing_state TEXT, billing_district TEXT, billing_city TEXT, billing_pincode TEXT, precise_location TEXT,
        consultant TEXT, enquiry_product TEXT, enquiry_notes TEXT, industry_type TEXT, quotation TEXT,
        lead_source TEXT, lead_status TEXT, loss_reason TEXT, requirements_summary TEXT, assigned_to TEXT,
        sales_owner_id BIGINT, current_assignee_id BIGINT, raw_data JSONB,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TEMP TABLE customers (
        id INTEGER PRIMARY KEY, company_name TEXT, industry TEXT, segment TEXT, site_location TEXT,
        city TEXT, state TEXT, billing_address TEXT, consultant TEXT, contact_person_name TEXT,
        contact_person_phone TEXT, contact_person_email TEXT, raw_data JSONB
      );
      CREATE TEMP TABLE estimation_requests (id INTEGER PRIMARY KEY, lead_id INTEGER, status TEXT,
        assigned_engineer_id BIGINT, estimation_head_id BIGINT, sales_owner_id BIGINT, sales_owner_name TEXT,
        project_name TEXT, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);
      CREATE TEMP TABLE lead_activities (id SERIAL PRIMARY KEY, lead_id INTEGER, activity_type TEXT, content TEXT,
        actor_name TEXT, actor_user_id BIGINT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);
      CREATE TEMP TABLE user_notifications (id SERIAL PRIMARY KEY, recipient_user_id BIGINT, recipient_name TEXT,
        title TEXT, body TEXT, category TEXT, link_type TEXT, link_id INTEGER, metadata JSONB,
        read_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO leads (id, company_name, project_name, contact_person_name, contact_person_email, contact_person_phone,
        enquiry_date, enquiry_state, sales_approval_status, priority, customer_id, lead_source, lead_status, assigned_to, sales_owner_id)
        VALUES (7, 'Acme', 'Original project', 'Customer', 'customer@example.com', '9876543210', '2026-10-26',
          'Purchase', 'Not Vivid Approved', 'Medium', 10, 'Website', 'New', 'Sales Engineer', 1);
      INSERT INTO customers (id, company_name) VALUES (10, 'Acme');
      INSERT INTO estimation_requests (id, lead_id, status, assigned_engineer_id, estimation_head_id)
        VALUES (8, 7, 'assigned', 4, 3);
    `);
    await createLeadChangeRequestSchema({ query: (sql) => client.query(sql.replace('CREATE TABLE IF NOT EXISTS lead_change_requests', 'CREATE TEMP TABLE lead_change_requests')) });
    const salesEngineer = { id: 1, name: 'Sales Engineer', role: 'sales_engineer' };
    const salesHead = { id: 2, name: 'Sales Head', role: 'sales_head' };
    const estimationHead = { id: 3, name: 'Estimation Head', role: 'estimation_head' };
    const original = (await client.query('SELECT *, enquiry_date::text AS enquiry_date FROM leads WHERE id = 7')).rows[0];
    await client.query('BEGIN');
    const proposed = await updateLead(7, { ...original, project_name: 'Revised project', change_reviewers: { sales_head_id: 2, estimation_head_id: 3 } }, salesEngineer, { db });
    await client.query('COMMIT');
    assert.equal(proposed.approval_required, true);
    assert.equal((await client.query('SELECT project_name FROM leads WHERE id = 7')).rows[0].project_name, 'Original project');
    const requestId = proposed.change_request.id;
    await assert.rejects(reviewLeadChange(requestId, 'approve', '', { ...salesHead, id: 6 }, deps), { statusCode: 403 });
    assert.equal((await reviewLeadChange(requestId, 'approve', 'Sales reviewed', salesHead, deps)).status, 'pending');
    assert.equal((await client.query('SELECT project_name FROM leads WHERE id = 7')).rows[0].project_name, 'Original project');
    const applied = await reviewLeadChange(requestId, 'approve', 'Estimation reviewed', estimationHead, deps);
    assert.equal(applied.status, 'applied');
    assert.equal((await client.query('SELECT project_name FROM leads WHERE id = 7')).rows[0].project_name, 'Revised project');
    // Only Admin and Sales Head can reassign; exercise both permitted paths.
    for (const [actor, ownerId] of [[{ id: 20, name: 'Admin', role: 'admin' }, 7], [salesHead, 1]]) {
      const latest = (await client.query('SELECT *, enquiry_date::text AS enquiry_date FROM leads WHERE id = 7')).rows[0];
      await client.query('BEGIN');
      const reassigned = await updateLead(7, { ...latest, sales_owner_id: ownerId }, actor, { db });
      await client.query('COMMIT');
      assert.equal(String(reassigned.sales_owner_id), String(ownerId));
    }
    const notifications = (await client.query(`SELECT recipient_user_id::text AS id FROM user_notifications WHERE title = 'Approved lead changes applied' ORDER BY recipient_user_id`)).rows;
    assert.deepEqual(notifications.map((row) => row.id), ['3', '4']);
    assert.equal((await client.query(`SELECT COUNT(*)::int AS n FROM lead_activities WHERE metadata->>'event' = 'lead_change_applied'`)).rows[0].n, 1);
    assert.equal((await listLeadChanges({ id: 4, role: 'estimation_engineer' }, db)).length, 1);
    assert.equal((await listLeadChanges({ id: 5, role: 'estimation_engineer' }, db)).length, 0);
    await assert.rejects(reviewLeadChange(requestId, 'approve', '', estimationHead, deps), { statusCode: 409 });

    const current = (await client.query('SELECT *, enquiry_date::text AS enquiry_date FROM leads WHERE id = 7')).rows[0];
    await client.query('BEGIN');
    const stale = await updateLead(7, { ...current, project_name: 'Next proposal', change_reviewers: { sales_head_id: 2, estimation_head_id: 3 } }, salesEngineer, { db });
    await client.query('COMMIT');
    await client.query(`UPDATE leads SET priority = 'High' WHERE id = 7`);
    await reviewLeadChange(stale.change_request.id, 'approve', '', salesHead, deps);
    assert.equal((await reviewLeadChange(stale.change_request.id, 'approve', '', estimationHead, deps)).status, 'conflict');
    assert.equal((await client.query('SELECT project_name FROM leads WHERE id = 7')).rows[0].project_name, 'Revised project');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release(true);
    await pool.end();
  }
});
