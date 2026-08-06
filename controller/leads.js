const pool = require('../config/db_connection');

const LEAD_COLUMNS = `
  id,
  company_name,
  contact_person_name,
  contact_person_email,
  contact_person_phone,
  quotation,
  lead_source,
  lead_status,
  requirements_summary,
  assigned_to,
  created_at,
  raw_data
`;

function leadValues(leadData) {
  return [
    leadData.company_name,
    leadData.contact_person_name,
    leadData.contact_person_email,
    leadData.contact_person_phone,
    leadData.quotation || null,
    leadData.lead_source,
    leadData.lead_status,
    leadData.requirements_summary || null,
    leadData.assigned_to || null,
    leadData.raw_data || null,
  ];
}

async function retrieveLeads() {
  const result = await pool.query(`SELECT ${LEAD_COLUMNS} FROM leads ORDER BY created_at DESC, id DESC`);
  return result.rows;
}

async function createLead(leadData) {
  const result = await pool.query(
    `INSERT INTO leads (
      company_name,
      contact_person_name,
      contact_person_email,
      contact_person_phone,
      quotation,
      lead_source,
      lead_status,
      requirements_summary,
      assigned_to,
      raw_data
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING ${LEAD_COLUMNS}`,
    leadValues(leadData),
  );

  return result.rows[0];
}

async function updateLead(id, leadData) {
  const result = await pool.query(
    `UPDATE leads
     SET company_name = $1,
         contact_person_name = $2,
         contact_person_email = $3,
         contact_person_phone = $4,
         quotation = $5,
         lead_source = $6,
         lead_status = $7,
         requirements_summary = $8,
         assigned_to = $9,
         raw_data = $10
     WHERE id = $11
     RETURNING ${LEAD_COLUMNS}`,
    [...leadValues(leadData), id],
  );

  return result.rows[0] || null;
}

async function deleteLead(id) {
  const result = await pool.query(
    `DELETE FROM leads WHERE id = $1 RETURNING id`,
    [id],
  );

  return result.rows[0] || null;
}

async function acceptProposal(id, quotation) {
  const result = await pool.query(
    `UPDATE leads
     SET lead_status = 'Proposal Accepted',
         quotation = $1
     WHERE id = $2
     RETURNING ${LEAD_COLUMNS}`,
    [quotation || 'Sent', id],
  );

  return result.rows[0] || null;
}

module.exports = {
  retrieveLeads,
  createLead,
  updateLead,
  deleteLead,
  acceptProposal,
};
