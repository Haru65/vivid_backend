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

const ACTIVITY_TYPES = new Set(['note', 'call', 'whatsapp', 'system', 'email', 'meeting', 'negotiation', 'approval_requested', 'approval']);
const LEAD_STATUSES = new Set(['New', 'Qualified', 'Proposal Sent', 'Negotiation', 'Proposal Accepted', 'Lost']);
const QUOTATION_REQUIRED_STATUSES = new Set(['Proposal Sent', 'Negotiation', 'Proposal Accepted']);
const FOLLOWUP_TYPES = new Set(['Call', 'WhatsApp', 'Email', 'Meeting', 'Payment', 'Quotation', 'General']);
const FOLLOWUP_PRIORITIES = new Set(['Low', 'Medium', 'High', 'Urgent']);
const FOLLOWUP_STATUSES = new Set(['Open', 'Completed', 'Cancelled']);

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function activityColumns(alias = 'a') {
  return `${alias}.id, ${alias}.lead_id, ${alias}.activity_type, ${alias}.content, ${alias}.actor_name, ${alias}.metadata, ${alias}.created_at`;
}

function followupColumns(alias = 'f') {
  return `${alias}.id, ${alias}.lead_id, ${alias}.followup_type, ${alias}.title, ${alias}.notes, ${alias}.due_at, ${alias}.priority, ${alias}.status, ${alias}.assigned_to, ${alias}.completed_at, ${alias}.created_by, ${alias}.created_at, ${alias}.updated_at`;
}

function followupJson(alias = 'f') {
  return `json_build_object(
    'id', ${alias}.id,
    'lead_id', ${alias}.lead_id,
    'followup_type', ${alias}.followup_type,
    'title', ${alias}.title,
    'notes', ${alias}.notes,
    'due_at', ${alias}.due_at,
    'priority', ${alias}.priority,
    'status', ${alias}.status,
    'assigned_to', ${alias}.assigned_to,
    'completed_at', ${alias}.completed_at,
    'created_by', ${alias}.created_by,
    'created_at', ${alias}.created_at,
    'updated_at', ${alias}.updated_at
  )`;
}

function normalizeActivity(activityData = {}) {
  const type = activityData.activity_type || 'note';
  if (!ACTIVITY_TYPES.has(type)) throw validationError('Activity type is invalid.');
  if (typeof activityData.content !== 'string' || !activityData.content.trim()) {
    throw validationError('Activity content is required.');
  }
  const content = activityData.content.trim();
  if (content.length > 5000) throw validationError('Activity content is too long.');
  const metadata = activityData.metadata && typeof activityData.metadata === 'object' && !Array.isArray(activityData.metadata)
    ? activityData.metadata
    : {};
  return { type, content, metadata };
}

function actorName(user) {
  return user?.name || 'Workspace user';
}

function text(value, field, maxLength, required = false) {
  if (value === undefined || value === null) {
    if (required) throw validationError(`${field} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw validationError(`${field} must be text.`);
  const result = value.trim();
  if (required && !result) throw validationError(`${field} is required.`);
  if (result.length > maxLength) throw validationError(`${field} is too long.`);
  return result || null;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw validationError(`${field} is required.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw validationError(`${field} must be a valid date and time.`);
  return date.toISOString();
}

function phone(value, field, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw validationError(`${field} is required.`);
    return null;
  }
  const digits = String(value).replace(/\D/g, '');
  if (required && !digits) throw validationError(`${field} is required.`);
  if (digits && digits.length !== 10) throw validationError(`${field} must be exactly 10 digits.`);
  return digits || null;
}

function email(value, field, required = false) {
  const result = text(value, field, 255, required);
  if (!result) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(result)) throw validationError(`${field} must be a valid email address.`);
  return result;
}

function jsonObject(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw validationError(`${field} must be a JSON object.`);
  return value;
}

function normalizeFollowup(data = {}, fallbackAssignee) {
  const followupType = data.followup_type || 'General';
  if (!FOLLOWUP_TYPES.has(followupType)) throw validationError('Follow-up type is invalid.');
  const priority = data.priority || 'Medium';
  if (!FOLLOWUP_PRIORITIES.has(priority)) throw validationError('Follow-up priority is invalid.');
  const status = data.status || 'Open';
  if (!FOLLOWUP_STATUSES.has(status)) throw validationError('Follow-up status is invalid.');

  return {
    followupType,
    title: text(data.title, 'Follow-up title', 255, true),
    notes: text(data.notes, 'Follow-up notes', 5000),
    dueAt: timestamp(data.due_at, 'Follow-up due date'),
    priority,
    status,
    assignedTo: text(data.assigned_to || fallbackAssignee, 'Assigned to', 255),
  };
}

async function leadForAccess(leadId, user) {
  const result = await pool.query(
    'SELECT id, company_name, assigned_to FROM leads WHERE id = $1',
    [leadId],
  );
  const lead = result.rows[0];
  if (!lead) {
    const error = new Error('Lead not found.');
    error.statusCode = 404;
    throw error;
  }
  if (user?.role === 'salesperson' && lead.assigned_to !== user.name) {
    const error = new Error('Salespersons can only manage follow-ups for their assigned leads.');
    error.statusCode = 403;
    throw error;
  }
  return lead;
}

async function insertLeadActivity(leadId, activityData, user, db = pool) {
  const { type, content, metadata } = normalizeActivity(activityData);
  const result = await db.query(
    `INSERT INTO lead_activities (lead_id, activity_type, content, actor_name, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${activityColumns('lead_activities')}`,
    [leadId, type, content, actorName(user), JSON.stringify(metadata)],
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
          'metadata', a.metadata,
          'created_at', a.created_at
        ) ORDER BY a.created_at DESC, a.id DESC)
        FROM lead_activities a
        WHERE a.lead_id = l.id
      ), '[]'::json) AS activities
      , COALESCE((
        SELECT json_agg(${followupJson('f')} ORDER BY f.due_at ASC, f.id ASC)
        FROM lead_followups f
        WHERE f.lead_id = l.id
      ), '[]'::json) AS followups
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
  const status = text(leadData.lead_status, 'Lead status', 50, true);
  if (!LEAD_STATUSES.has(status)) throw validationError('Lead status is invalid.');
  return [
    text(leadData.company_name, 'Company name', 255, true),
    text(leadData.contact_person_name, 'Contact person', 255, true),
    email(leadData.contact_person_email, 'Contact email', true),
    phone(leadData.contact_person_phone, 'Contact phone', true),
    text(leadData.quotation, 'Quotation reference', 255),
    text(leadData.lead_source, 'Lead source', 255, true),
    status,
    text(leadData.requirements_summary, 'Requirements summary', 5000),
    text(leadData.assigned_to, 'Assigned to', 255),
    jsonObject(leadData.raw_data, 'Raw data'),
  ];
}

async function sentQuotationForLead(lead) {
  const params = [lead.id];
  let where = 'lead_id = $1';
  if (lead.quotation) {
    params.push(lead.quotation);
    where = '(lead_id = $1 OR quotation_number = $2)';
  }
  const result = await pool.query(
    `SELECT id, quotation_number, status
     FROM quotations
     WHERE ${where}
       AND status IN ('Sent', 'Approved', 'Superseded')
     ORDER BY sent_at DESC NULLS LAST, created_at DESC, id DESC
     LIMIT 1`,
    params,
  );
  return result.rows[0] || null;
}

async function ensureLeadStatusAllowed(lead, nextStatus) {
  if (!QUOTATION_REQUIRED_STATUSES.has(nextStatus)) return null;
  const quotation = await sentQuotationForLead(lead);
  if (!quotation) {
    const action = nextStatus === 'Proposal Accepted' ? 'accepting this lead' : `moving this lead to ${nextStatus}`;
    throw validationError(`Send a quotation before ${action}.`);
  }
  return quotation;
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
          'metadata', a.metadata,
          'created_at', a.created_at
        ) ORDER BY a.created_at DESC, a.id DESC)
        FROM lead_activities a
        WHERE a.lead_id = l.id
      ), '[]'::json) AS activities
      , COALESCE((
        SELECT json_agg(${followupJson('f')} ORDER BY f.due_at ASC, f.id ASC)
        FROM lead_followups f
        WHERE f.lead_id = l.id
      ), '[]'::json) AS followups
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

async function retrieveLeadFollowups(leadId, user) {
  await leadForAccess(leadId, user);
  const result = await pool.query(
    `SELECT ${followupColumns()}
     FROM lead_followups f
     WHERE f.lead_id = $1
     ORDER BY CASE f.status WHEN 'Open' THEN 0 WHEN 'Completed' THEN 1 ELSE 2 END,
              f.due_at ASC,
              f.id ASC`,
    [leadId],
  );
  return result.rows;
}

async function createLeadFollowup(leadId, followupData, user) {
  const lead = await leadForAccess(leadId, user);
  const values = normalizeFollowup(followupData, lead.assigned_to || actorName(user));
  const result = await pool.query(
    `INSERT INTO lead_followups (
      lead_id,
      followup_type,
      title,
      notes,
      due_at,
      priority,
      status,
      assigned_to,
      completed_at,
      created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $7::varchar = 'Completed' THEN CURRENT_TIMESTAMP ELSE NULL END, $9)
    RETURNING ${followupColumns('lead_followups')}`,
    [lead.id, values.followupType, values.title, values.notes, values.dueAt, values.priority, values.status, values.assignedTo, actorName(user)],
  );
  const followup = result.rows[0];
  await logLeadActivity(lead.id, {
    activity_type: 'system',
    content: `Follow-up scheduled: ${followup.followup_type} - ${followup.title}`,
  }, user);
  return followup;
}

async function updateLeadFollowup(leadId, followupId, followupData, user) {
  const lead = await leadForAccess(leadId, user);
  const existing = await pool.query(
    `SELECT ${followupColumns()}
     FROM lead_followups f
     WHERE f.id = $1 AND f.lead_id = $2`,
    [followupId, lead.id],
  );
  if (!existing.rows[0]) return null;

  const values = normalizeFollowup(followupData, existing.rows[0].assigned_to || lead.assigned_to || actorName(user));
  const result = await pool.query(
    `UPDATE lead_followups
     SET followup_type = $1,
         title = $2,
         notes = $3,
         due_at = $4,
         priority = $5,
         status = $6,
         assigned_to = $7,
         completed_at = CASE
           WHEN $6::varchar = 'Completed' AND completed_at IS NULL THEN CURRENT_TIMESTAMP
           WHEN $6::varchar <> 'Completed' THEN NULL
           ELSE completed_at
         END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $8 AND lead_id = $9
     RETURNING ${followupColumns('lead_followups')}`,
    [values.followupType, values.title, values.notes, values.dueAt, values.priority, values.status, values.assignedTo, followupId, lead.id],
  );
  const followup = result.rows[0] || null;
  if (!followup) return null;

  const statusChanged = existing.rows[0].status !== followup.status;
  await logLeadActivity(lead.id, {
    activity_type: 'system',
    content: statusChanged
      ? `Follow-up ${followup.status.toLowerCase()}: ${followup.followup_type} - ${followup.title}`
      : `Follow-up updated: ${followup.followup_type} - ${followup.title}`,
  }, user);
  return followup;
}

async function completeLeadFollowup(leadId, followupId, user) {
  const lead = await leadForAccess(leadId, user);
  const result = await pool.query(
    `UPDATE lead_followups
     SET status = 'Completed',
         completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND lead_id = $2
     RETURNING ${followupColumns('lead_followups')}`,
    [followupId, lead.id],
  );
  const followup = result.rows[0] || null;
  if (!followup) return null;
  await logLeadActivity(lead.id, {
    activity_type: 'system',
    content: `Follow-up completed: ${followup.followup_type} - ${followup.title}`,
  }, user);
  return followup;
}

async function cancelLeadFollowup(leadId, followupId, user) {
  const lead = await leadForAccess(leadId, user);
  const result = await pool.query(
    `UPDATE lead_followups
     SET status = 'Cancelled',
         completed_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND lead_id = $2
     RETURNING ${followupColumns('lead_followups')}`,
    [followupId, lead.id],
  );
  const followup = result.rows[0] || null;
  if (!followup) return null;
  await logLeadActivity(lead.id, {
    activity_type: 'system',
    content: `Follow-up cancelled: ${followup.followup_type} - ${followup.title}`,
  }, user);
  return followup;
}

async function createLead(leadData, user) {
  const values = leadValues(leadData);
  if (QUOTATION_REQUIRED_STATUSES.has(values[6])) {
    throw validationError(`Create the lead and send a quotation before moving it to ${values[6]}.`);
  }
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
    values,
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

  const values = leadValues(leadData);
  await ensureLeadStatusAllowed({
    ...previous,
    quotation: values[4] || previous.quotation,
  }, values[6]);

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
    [...values, id],
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
  const previousResult = await pool.query(
    `SELECT ${LEAD_COLUMNS}
     FROM leads
     WHERE id = $1`,
    [id],
  );
  const previous = previousResult.rows[0];
  if (!previous) return null;
  const sentQuotation = await ensureLeadStatusAllowed(previous, 'Proposal Accepted');
  const result = await pool.query(
    `UPDATE leads
     SET lead_status = 'Proposal Accepted',
         quotation = $1
     WHERE id = $2
     RETURNING ${LEAD_COLUMNS}`,
    [quotation && quotation !== 'Sent' ? quotation : sentQuotation.quotation_number, id],
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
  retrieveLeadFollowups,
  createLeadFollowup,
  updateLeadFollowup,
  completeLeadFollowup,
  cancelLeadFollowup,
  logLeadActivity,
  createLead,
  updateLead,
  deleteLead,
  acceptProposal,
};
