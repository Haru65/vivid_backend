const pool = require('../config/db_connection');
const { getMasterSettings } = require('./settings');
const { notifyUserId } = require('../services/notificationService');

const LEAD_COLUMNS = `
  id,
  company_name,
  contact_person_name,
  contact_person_email,
  contact_person_phone,
  enquiry_date,
  enquiry_state,
  sales_approval_status,
  priority,
  customer_id,
  segment,
  site_location,
  consultant,
  enquiry_product,
  enquiry_notes,
  industry_type,
  quotation,
  lead_source,
  lead_status,
  NULLIF(to_jsonb(leads)->>'loss_reason', '') AS loss_reason,
  NULLIF(to_jsonb(leads)->>'sales_owner_id', '')::BIGINT AS sales_owner_id,
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
  l.enquiry_date,
  l.enquiry_state,
  l.sales_approval_status,
  l.priority,
  l.customer_id,
  l.segment,
  l.site_location,
  l.consultant,
  l.enquiry_product,
  l.enquiry_notes,
  l.industry_type,
  l.quotation,
  l.lead_source,
  l.lead_status,
  NULLIF(to_jsonb(l)->>'loss_reason', '') AS loss_reason,
  NULLIF(to_jsonb(l)->>'sales_owner_id', '')::BIGINT AS sales_owner_id,
  l.requirements_summary,
  l.assigned_to,
  l.created_at,
  l.raw_data
`;

const ACTIVITY_TYPES = new Set(['note', 'call', 'whatsapp', 'system', 'email', 'meeting', 'negotiation', 'approval_requested', 'approval']);
const LEAD_STATUSES = new Set(['New', 'Qualified', 'Proposal Sent', 'Negotiation', 'Proposal Accepted', 'Lost']);
const LEAD_PRIORITIES = new Set(['Low', 'Medium', 'High', 'Urgent']);
const ENQUIRY_STATES = new Set(['Purchase', 'Tender', 'Budget']);
const SALES_APPROVAL_STATUSES = new Set(['Vivid Approved', 'ABB Approval', 'Not Vivid Approved']);
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
function roleOf(user) {
  return String(user?.role || '').trim().toLowerCase();
}

function isIndividualSales(user) {
  return ['salesperson', 'sales_engineer'].includes(roleOf(user));
}

function canAccessLead(lead, user) {
  if (!isIndividualSales(user)) return true;
  return String(lead?.sales_owner_id || '') === String(user?.id || '')
    || String(lead?.assigned_to || '').trim() === actorName(user);
}

async function resolveSalesOwner(data, user, db = pool) {
  if (isIndividualSales(user)) {
    return { id: Number(user.id), name: actorName(user) };
  }
  if (!['admin', 'sales_head'].includes(roleOf(user))) {
    throw Object.assign(new Error('Only Sales Head or Admin can assign leads.'), { statusCode: 403 });
  }
  const ownerId = Number(data.sales_owner_id);
  if (!Number.isInteger(ownerId) || ownerId <= 0) throw validationError('Select a sales person to assign this lead.');
  const result = await db.query(
    `SELECT id, first_name, last_name
     FROM users
     WHERE id = $1
       AND is_active = TRUE
       AND role IN ('salesperson', 'sales_engineer')`,
    [ownerId],
  );
  if (!result.rows[0]) throw validationError('Select an active salesperson or sales engineer.');
  return {
    id: Number(result.rows[0].id),
    name: [result.rows[0].first_name, result.rows[0].last_name].filter(Boolean).join(' '),
  };
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

function dateOnly(value, field, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw validationError(`${field} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw validationError(`${field} must be a valid date.`);
  const trimmed = value.trim();
  const date = new Date(`${trimmed}T00:00:00`);
  if (Number.isNaN(date.getTime())) throw validationError(`${field} must be a valid date.`);
  return trimmed.slice(0, 10);
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
    `SELECT id, company_name, assigned_to, NULLIF(to_jsonb(leads)->>'sales_owner_id', '')::BIGINT AS sales_owner_id FROM leads WHERE id = $1`,
    [leadId],
  );
  const lead = result.rows[0];
  if (!lead) {
    const error = new Error('Lead not found.');
    error.statusCode = 404;
    throw error;
  }
  if (!canAccessLead(lead, user)) {
    const error = new Error('You can access only leads assigned to you.');
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
    ['enquiry_date', 'enquiry date'],
    ['enquiry_state', 'enquiry state'],
    ['sales_approval_status', 'sales approval status'],
    ['priority', 'priority'],
    ['segment', 'segment'],
    ['site_location', 'site location'],
    ['consultant', 'consultant'],
    ['enquiry_product', 'enquiry product'],
    ['enquiry_notes', 'enquiry notes'],
    ['industry_type', 'industry type'],
    ['quotation', 'quotation reference'],
    ['lead_source', 'lead source'],
    ['loss_reason', 'loss reason'],
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
  const priority = text(leadData.priority || 'Medium', 'Priority', 20, true);
  if (!LEAD_PRIORITIES.has(priority)) throw validationError('Priority is invalid.');
  const enquiryState = text(leadData.enquiry_state || 'Purchase', 'Enquiry state', 20, true);
  if (!ENQUIRY_STATES.has(enquiryState)) throw validationError('Enquiry state is invalid.');
  const salesApprovalStatus = text(leadData.sales_approval_status || 'Not Vivid Approved', 'Sales approval status', 30, true);
  if (!SALES_APPROVAL_STATUSES.has(salesApprovalStatus)) throw validationError('Sales approval status is invalid.');
  return [
    text(leadData.company_name, 'Company name', 255, true),
    text(leadData.contact_person_name, 'Contact person', 255, true),
    email(leadData.contact_person_email, 'Contact email', true),
    phone(leadData.contact_person_phone, 'Contact phone', true),
    dateOnly(leadData.enquiry_date, 'Enquiry date', true),
    priority,
    text(leadData.segment, 'Segment', 100),
    text(leadData.site_location, 'Site location', 255),
    text(leadData.consultant, 'Consultant', 255),
    text(Array.isArray(leadData.enquiry_product) ? leadData.enquiry_product.join(', ') : leadData.enquiry_product, 'Enquiry product', 1000),
    text(leadData.enquiry_notes, 'Enquiry notes', 5000),
    text(leadData.industry_type, 'Industry type', 100),
    text(leadData.quotation, 'Quotation reference', 255),
    text(leadData.lead_source, 'Lead source', 255, true),
    status,
    text(leadData.requirements_summary, 'Requirements summary', 5000),
    text(leadData.assigned_to, 'Assigned to', 255),
    jsonObject(leadData.raw_data, 'Raw data'),
    enquiryState,
    salesApprovalStatus,
    status === 'Lost' ? text(leadData.loss_reason, 'Loss reason', 255, true) : null,
  ];
}

async function ensureLossReasonAllowed(status, lossReason) {
  if (status !== 'Lost') return;
  const settings = await getMasterSettings();
  const reasons = Array.isArray(settings.loss_reasons) ? settings.loss_reasons : [];
  const selected = String(lossReason || '').trim();
  if (!reasons.some((reason) => String(reason).trim().toLowerCase() === selected.toLowerCase())) {
    throw validationError('Select a loss reason configured in Masters.');
  }
}

async function ensureLeadSourceAllowed(leadSource, existingLeadSource = null) {
  const value = String(leadSource || '').trim();
  if (existingLeadSource && value.toLowerCase() === String(existingLeadSource).trim().toLowerCase()) return;
  const settings = await getMasterSettings();
  const sources = Array.isArray(settings.lead_sources) ? settings.lead_sources : [];
  if (!sources.some((source) => source.toLowerCase() === value.toLowerCase())) {
    throw validationError('Select a lead source configured in Masters.');
  }
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

async function retrieveLeads(user) {
  const individual = isIndividualSales(user);
  const params = individual ? [user?.id || null, actorName(user)] : [];
  const where = individual ? `WHERE NULLIF(to_jsonb(l)->>'sales_owner_id', '')::BIGINT = $1 OR l.assigned_to = $2` : '';
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
    ${where}
    ORDER BY l.created_at DESC, l.id DESC
  `, params);
  return result.rows;
}

async function retrieveLeadActivities(leadId, user) {
  if (isIndividualSales(user)) {
    const leadResult = await pool.query(
      `SELECT assigned_to, NULLIF(to_jsonb(leads)->>'sales_owner_id', '')::BIGINT AS sales_owner_id FROM leads WHERE id = $1`,
      [leadId],
    );
    const lead = leadResult.rows[0];
    if (!lead) {
      const error = new Error('Lead not found.');
      error.statusCode = 404;
      throw error;
    }
    if (!canAccessLead(lead, user)) {
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
    `SELECT id, assigned_to, NULLIF(to_jsonb(leads)->>'sales_owner_id', '')::BIGINT AS sales_owner_id FROM leads WHERE id = $1`,
    [leadId],
  );
  const lead = leadResult.rows[0];
  if (!lead) {
    const error = new Error('Lead not found.');
    error.statusCode = 404;
    throw error;
  }
  if (!canAccessLead(lead, user)) {
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

async function selectedCustomerForLead(client, customerId) {
  const id = Number(customerId);
  if (!Number.isInteger(id) || id <= 0) {
    throw validationError('Select a company from the customer database.');
  }
  const result = await client.query(
    `SELECT
       id,
       company_name,
       industry,
       segment,
       site_location,
       consultant,
       contact_person_name,
       contact_person_phone,
       COALESCE(contact_person_email, raw_data->>'contact_person_email') AS contact_person_email
     FROM customers
     WHERE id = $1
     FOR SHARE`,
    [id],
  );
  if (!result.rows[0]) throw validationError('The selected company is no longer available.');
  return result.rows[0];
}

function leadDataForCustomer(leadData, customer) {
  return {
    ...leadData,
    customer_id: customer.id,
    company_name: customer.company_name,
    contact_person_name: leadData.contact_person_name || customer.contact_person_name,
    contact_person_email: leadData.contact_person_email || customer.contact_person_email,
    contact_person_phone: leadData.contact_person_phone || customer.contact_person_phone,
    industry_type: leadData.industry_type || customer.industry,
    segment: leadData.segment || customer.segment,
    site_location: leadData.site_location || customer.site_location,
    consultant: leadData.consultant || customer.consultant,
  };
}

async function createLead(leadData, user) {
  const client = await pool.connect();
  let lead;
  let customer;
  let owner;
  try {
    await client.query('BEGIN');
    customer = await selectedCustomerForLead(client, leadData.customer_id);
    owner = await resolveSalesOwner(leadData, user, client);
    const ownedLeadData = leadDataForCustomer({ ...leadData, assigned_to: owner.name }, customer);
    await ensureLeadSourceAllowed(ownedLeadData.lead_source);
    await ensureLossReasonAllowed(ownedLeadData.lead_status, ownedLeadData.loss_reason);
    const values = leadValues(ownedLeadData);
    if (QUOTATION_REQUIRED_STATUSES.has(values[14])) {
      throw validationError(`Create the lead and send a quotation before moving it to ${values[14]}.`);
    }
    const insertValues = [...values.slice(0, 6), customer.id, ...values.slice(6, 17), owner.id, owner.id, ...values.slice(17)];
    const result = await client.query(
      `INSERT INTO leads (
        company_name,
        contact_person_name,
        contact_person_email,
        contact_person_phone,
        enquiry_date,
        priority,
        customer_id,
        segment,
        site_location,
        consultant,
        enquiry_product,
        enquiry_notes,
        industry_type,
        quotation,
        lead_source,
        lead_status,
        requirements_summary,
        assigned_to,
        sales_owner_id,
        current_assignee_id,
        raw_data,
        enquiry_state,
        sales_approval_status,
        loss_reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
      RETURNING ${LEAD_COLUMNS}`,
      insertValues,
    );
    lead = result.rows[0];
    await client.query(
      `UPDATE customers
       SET source_lead_id = COALESCE(source_lead_id, $2),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [customer.id, lead.id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await logLeadActivity(lead.id, {
    activity_type: 'system',
    content: `Lead created for ${lead.company_name} and assigned to ${owner.name}`,
  }, user);
  await logLeadActivity(lead.id, {
    activity_type: 'system',
    content: `Customer account linked to ${customer.company_name}`,
  }, user);
  if (String(owner.id) !== String(user?.id || '')) {
    await notifyUserId(owner.id, {
      title: 'New lead assigned to you',
      body: `${actorName(user)} assigned ${lead.company_name} to you.`,
      category: 'lead',
      link_type: 'lead',
      link_id: lead.id,
    });
  }

  return (await retrieveLead(lead.id)) || lead;
}

async function updateLead(id, leadData, user) {
  const client = await pool.connect();
  let previous;
  let lead;
  let owner;
  try {
    await client.query('BEGIN');
    const previousResult = await client.query(
      `SELECT ${LEAD_COLUMNS}
       FROM leads
       WHERE id = $1
       FOR UPDATE`,
      [id],
    );
    previous = previousResult.rows[0];
    if (!previous) {
      await client.query('ROLLBACK');
      return null;
    }
    if (!canAccessLead(previous, user)) throw Object.assign(new Error('You can update only leads assigned to you.'), { statusCode: 403 });

    const customer = await selectedCustomerForLead(client, leadData.customer_id || previous.customer_id);
    owner = await resolveSalesOwner(leadData, user, client);
    const ownedLeadData = leadDataForCustomer({ ...leadData, assigned_to: owner.name }, customer);
    await ensureLeadSourceAllowed(ownedLeadData.lead_source, previous.lead_source);
    await ensureLossReasonAllowed(ownedLeadData.lead_status, ownedLeadData.loss_reason);
    const values = leadValues(ownedLeadData);
    await ensureLeadStatusAllowed({
      ...previous,
      quotation: values[12] || previous.quotation,
    }, values[14]);
    const updateValues = [...values.slice(0, 6), customer.id, ...values.slice(6, 17), owner.id, owner.id, ...values.slice(17), id];

    const result = await client.query(
      `UPDATE leads
     SET company_name = $1,
         contact_person_name = $2,
         contact_person_email = $3,
         contact_person_phone = $4,
         enquiry_date = $5,
         priority = $6,
         customer_id = $7,
         segment = $8,
         site_location = $9,
         consultant = $10,
         enquiry_product = $11,
         enquiry_notes = $12,
         industry_type = $13,
         quotation = $14,
         lead_source = $15,
         lead_status = $16,
         requirements_summary = $17,
         assigned_to = $18,
         sales_owner_id = $19,
         current_assignee_id = $20,
         raw_data = $21,
         enquiry_state = $22,
         sales_approval_status = $23,
         loss_reason = $24,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $25
     RETURNING ${LEAD_COLUMNS}`,
      updateValues,
    );
    lead = result.rows[0] || null;
    if (!lead) throw new Error('Lead update failed.');

    if (changed(previous, lead, 'assigned_to') || String(previous.sales_owner_id || '') !== String(owner.id)) {
      await client.query(
        `UPDATE estimation_requests
         SET sales_owner_id = $1,
             sales_owner_name = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE lead_id = $3
           AND status NOT IN ('cancelled', 'discarded')`,
        [owner.id, owner.name, id],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await Promise.all(leadUpdateActivities(previous, lead).map((content) => logLeadActivity(lead.id, {
    activity_type: 'system',
    content,
  }, user)));

  if ((changed(previous, lead, 'assigned_to') || String(previous.sales_owner_id || '') !== String(owner.id))
    && String(owner.id) !== String(user?.id || '')) {
    await notifyUserId(owner.id, {
      title: 'Lead assigned to you',
      body: `${actorName(user)} assigned ${lead.company_name} to you.`,
      category: 'lead',
      link_type: 'lead',
      link_id: lead.id,
    });
  }

  return (await retrieveLead(lead.id)) || lead;
}

async function deleteLead(id, user) {
  await leadForAccess(id, user);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dependencies = await client.query(
      `SELECT
         EXISTS (SELECT 1 FROM quotations WHERE lead_id = $1) AS has_quotations,
         EXISTS (SELECT 1 FROM estimation_requests WHERE lead_id = $1) AS has_estimation,
         EXISTS (SELECT 1 FROM meetings WHERE lead_id = $1) AS has_meetings,
         EXISTS (SELECT 1 FROM crm_erp_handovers WHERE lead_id = $1) AS has_handovers,
         EXISTS (SELECT 1 FROM projects WHERE lead_id = $1) AS has_projects`,
      [id],
    );
    const linked = dependencies.rows[0];
    if (Object.values(linked).some(Boolean)) {
      throw Object.assign(new Error('This lead has quotation, estimation, meeting, or ERP history and cannot be deleted.'), { statusCode: 409 });
    }

    await client.query(
      `UPDATE customers c
       SET source_lead_id = (
         SELECT l.id
         FROM leads l
         WHERE l.customer_id = c.id AND l.id <> $1
         ORDER BY l.created_at ASC, l.id ASC
         LIMIT 1
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE c.source_lead_id = $1`,
      [id],
    );
    await client.query('DELETE FROM lead_followups WHERE lead_id = $1', [id]);
    await client.query('DELETE FROM lead_activities WHERE lead_id = $1', [id]);
    const result = await client.query('DELETE FROM leads WHERE id = $1 RETURNING id', [id]);
    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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
  if (!canAccessLead(previous, user)) throw Object.assign(new Error('You can accept only proposals assigned to you.'), { statusCode: 403 });
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
