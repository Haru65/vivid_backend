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

const LEAD_TABLE_COLUMNS = `
  l.id,
  l.company_name,
  l.contact_person_name,
  l.contact_person_email,
  l.contact_person_phone,
  l.quotation,
  l.lead_source,
  l.lead_status,
  l.requirements_summary,
  l.assigned_to,
  l.created_at,
  l.raw_data
`;

const ACTIVITY_TYPES = new Set(['note', 'call', 'whatsapp', 'system', 'email', 'meeting']);

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function activityColumns(alias = 'a') {
  return `${alias}.id, ${alias}.lead_id, ${alias}.activity_type, ${alias}.content, ${alias}.actor_name, ${alias}.created_at`;
}

function normalizeActivity(activityData = {}) {
  const type = activityData.activity_type || 'note';
  if (!ACTIVITY_TYPES.has(type)) throw validationError('Activity type is invalid.');
  if (typeof activityData.content !== 'string' || !activityData.content.trim()) {
    throw validationError('Activity content is required.');
  }
  const content = activityData.content.trim();
  if (content.length > 5000) throw validationError('Activity content is too long.');
  return { type, content };
}

function actorName(user) {
  return user?.name || 'Workspace user';
}

async function insertLeadActivity(leadId, activityData, user, db = pool) {
  const { type, content } = normalizeActivity(activityData);
  const result = await db.query(
    `INSERT INTO lead_activities (lead_id, activity_type, content, actor_name)
     VALUES ($1, $2, $3, $4)
     RETURNING ${activityColumns('lead_activities')}`,
    [leadId, type, content, actorName(user)],
  );
  return result.rows[0];
}

async function logLeadActivity(leadId, activityData, user, db = pool) {
  try {
    return await insertLeadActivity(leadId, activityData, user, db);
  } catch (error) {
    console.error('Failed to create lead activity:', error);
    return null;
  }
}

async function retrieveLead(id) {
  const result = await pool.query(`
    SELECT ${LEAD_TABLE_COLUMNS},
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', a.id,
          'lead_id', a.lead_id,
          'activity_type', a.activity_type,
          'content', a.content,
          'actor_name', a.actor_name,
          'created_at', a.created_at
        ) ORDER BY a.created_at DESC, a.id DESC)
        FROM lead_activities a
        WHERE a.lead_id = l.id
      ), '[]'::json) AS activities
    FROM leads l
    WHERE l.id = $1
  `, [id]);
  return result.rows[0] || null;
}

function changed(previous, next, field) {
  return String(previous?.[field] || '') !== String(next?.[field] || '');
}

function leadUpdateActivities(previous, next) {
  const activities = [];
  if (changed(previous, next, 'lead_status')) {
    activities.push(`Lead status changed from ${previous.lead_status || 'Unspecified'} to ${next.lead_status || 'Unspecified'}`);
  }
  if (changed(previous, next, 'assigned_to')) {
    activities.push(`Lead assigned to ${next.assigned_to || 'Unassigned'}`);
  }

  const detailFields = [
    ['company_name', 'company name'],
    ['contact_person_name', 'contact person'],
    ['contact_person_email', 'contact email'],
    ['contact_person_phone', 'contact phone'],
    ['quotation', 'quotation reference'],
    ['lead_source', 'lead source'],
    ['requirements_summary', 'requirements summary'],
  ];
  const updatedFields = detailFields
    .filter(([field]) => changed(previous, next, field))
    .map(([, label]) => label);
  if (updatedFields.length) activities.push(`Lead details updated: ${updatedFields.join(', ')}`);
  return activities;
}

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
  const result = await pool.query(`
    SELECT ${LEAD_TABLE_COLUMNS},
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', a.id,
          'lead_id', a.lead_id,
          'activity_type', a.activity_type,
          'content', a.content,
          'actor_name', a.actor_name,
          'created_at', a.created_at
        ) ORDER BY a.created_at DESC, a.id DESC)
        FROM lead_activities a
        WHERE a.lead_id = l.id
      ), '[]'::json) AS activities
    FROM leads l
    ORDER BY l.created_at DESC, l.id DESC
  `);
  return result.rows;
}

async function retrieveLeadActivities(leadId, user) {
  if (user?.role === 'salesperson') {
    const leadResult = await pool.query(
      'SELECT assigned_to FROM leads WHERE id = $1',
      [leadId],
    );
    const lead = leadResult.rows[0];
    if (!lead) {
      const error = new Error('Lead not found.');
      error.statusCode = 404;
      throw error;
    }
    if (lead.assigned_to !== user.name) {
      const error = new Error('Salespersons can only view activity for their assigned leads.');
      error.statusCode = 403;
      throw error;
    }
  }

  const result = await pool.query(
    `SELECT ${activityColumns()}
     FROM lead_activities a
     WHERE a.lead_id = $1
     ORDER BY a.created_at DESC, a.id DESC`,
    [leadId],
  );
  return result.rows;
}

async function createLeadActivity(leadId, activityData, user) {
  normalizeActivity(activityData);

  const leadResult = await pool.query(
    'SELECT id, assigned_to FROM leads WHERE id = $1',
    [leadId],
  );
  const lead = leadResult.rows[0];
  if (!lead) {
    const error = new Error('Lead not found.');
    error.statusCode = 404;
    throw error;
  }
  if (user?.role === 'salesperson' && lead.assigned_to !== user.name) {
    const error = new Error('Salespersons can only add activity to their assigned leads.');
    error.statusCode = 403;
    throw error;
  }

  return insertLeadActivity(lead.id, activityData, user);
}

async function createLead(leadData, user) {
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
  const lead = result.rows[0];

  await logLeadActivity(lead.id, {
    activity_type: 'system',
    content: `Lead created for ${lead.company_name}`,
  }, user);

  return (await retrieveLead(lead.id)) || lead;
}

async function updateLead(id, leadData, user) {
  const previousResult = await pool.query(
    `SELECT ${LEAD_COLUMNS}
     FROM leads
     WHERE id = $1`,
    [id],
  );
  const previous = previousResult.rows[0];
  if (!previous) return null;

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

  const lead = result.rows[0] || null;
  if (!lead) return null;

  await Promise.all(leadUpdateActivities(previous, lead).map((content) => logLeadActivity(lead.id, {
    activity_type: 'system',
    content,
  }, user)));

  return (await retrieveLead(lead.id)) || lead;
}

async function deleteLead(id) {
  const result = await pool.query(
    `DELETE FROM leads WHERE id = $1 RETURNING id`,
    [id],
  );

  return result.rows[0] || null;
}

async function acceptProposal(id, quotation, user) {
  const result = await pool.query(
    `UPDATE leads
     SET lead_status = 'Proposal Accepted',
         quotation = $1
     WHERE id = $2
     RETURNING ${LEAD_COLUMNS}`,
    [quotation || 'Sent', id],
  );

  const lead = result.rows[0] || null;
  if (!lead) return null;

  await logLeadActivity(lead.id, {
    activity_type: 'system',
    content: `Proposal accepted${lead.quotation ? ` with quotation ${lead.quotation}` : ''}`,
  }, user);

  return (await retrieveLead(lead.id)) || lead;
}

module.exports = {
  retrieveLeads,
  retrieveLead,
  retrieveLeadActivities,
  createLeadActivity,
  logLeadActivity,
  createLead,
  updateLead,
  deleteLead,
  acceptProposal,
};
