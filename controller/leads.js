const pool = require('../config/db_connection');
const { getMasterSettings } = require('./settings');
const { notifyUserId } = require('../services/notificationService');

const LEAD_COLUMNS = `
  id,
  company_name,
  project_name,
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
  billing_state,
  billing_district,
  billing_city,
  billing_pincode,
  precise_location,
  consultant,
  enquiry_product,
  enquiry_notes,
  industry_type,
  quotation,
  lead_source,
  lead_status,
  NULLIF(to_jsonb(leads)->>'loss_reason', '') AS loss_reason,
  NULLIF(to_jsonb(leads)->>'hold_reason', '') AS hold_reason,
  NULLIF(to_jsonb(leads)->>'drop_reason', '') AS drop_reason,
  NULLIF(to_jsonb(leads)->>'status_before_hold', '') AS status_before_hold,
  to_jsonb(leads)->>'held_at' AS held_at,
  to_jsonb(leads)->>'dropped_at' AS dropped_at,
  NULLIF(to_jsonb(leads)->>'sales_owner_id', '')::BIGINT AS sales_owner_id,
  requirements_summary,
  assigned_to,
  created_at,
  raw_data
`;

const LEAD_TABLE_COLUMNS = `
  l.id,
  l.company_name,
  l.project_name,
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
  l.billing_state,
  l.billing_district,
  l.billing_city,
  l.billing_pincode,
  l.precise_location,
  l.consultant,
  l.enquiry_product,
  l.enquiry_notes,
  l.industry_type,
  l.quotation,
  l.lead_source,
  l.lead_status,
  NULLIF(to_jsonb(l)->>'loss_reason', '') AS loss_reason,
  NULLIF(to_jsonb(l)->>'hold_reason', '') AS hold_reason,
  NULLIF(to_jsonb(l)->>'drop_reason', '') AS drop_reason,
  NULLIF(to_jsonb(l)->>'status_before_hold', '') AS status_before_hold,
  to_jsonb(l)->>'held_at' AS held_at,
  to_jsonb(l)->>'dropped_at' AS dropped_at,
  NULLIF(to_jsonb(l)->>'sales_owner_id', '')::BIGINT AS sales_owner_id,
  l.requirements_summary,
  l.assigned_to,
  l.created_at,
  l.raw_data
`;

const ACTIVITY_TYPES = new Set(['note', 'call', 'whatsapp', 'system', 'email', 'meeting', 'negotiation', 'approval_requested', 'approval']);
const LEAD_STATUSES = new Set(['New', 'Qualified', 'Proposal Sent', 'Negotiation', 'Proposal Accepted', 'Lost', 'On Hold', 'Dropped']);
const LEAD_PRIORITIES = new Set(['Low', 'Medium', 'High', 'Urgent']);
const ENQUIRY_STATES = new Set(['Purchase', 'Tender', 'Budget']);
const SALES_APPROVAL_STATUSES = new Set(['Vivid Approved', 'Vivid Not Approved', 'OEM']);
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
  return `${alias}.id, ${alias}.lead_id, ${alias}.activity_type, ${alias}.content, ${alias}.actor_user_id, ${alias}.actor_name, ${alias}.metadata, ${alias}.created_at`;
}

function followupColumns(alias = 'f') {
  return `${alias}.id, ${alias}.lead_id, ${alias}.followup_type, ${alias}.title, ${alias}.notes, ${alias}.due_at, ${alias}.priority, ${alias}.status, ${alias}.assigned_to_user_id, ${alias}.assigned_to, ${alias}.completed_at, ${alias}.completion_latitude, ${alias}.completion_longitude, ${alias}.completion_accuracy_m, ${alias}.location_captured_at, ${alias}.created_by, ${alias}.created_at, ${alias}.updated_at`;
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
    'assigned_to_user_id', ${alias}.assigned_to_user_id,
    'assigned_to', ${alias}.assigned_to,
    'completed_at', ${alias}.completed_at,
    'completion_latitude', ${alias}.completion_latitude,
    'completion_longitude', ${alias}.completion_longitude,
    'completion_accuracy_m', ${alias}.completion_accuracy_m,
    'location_captured_at', ${alias}.location_captured_at,
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

function normalizeCompletionLocation(location) {
  if (!location || typeof location !== 'object' || Array.isArray(location)) {
    throw validationError('Current location is required to complete an onsite meeting.');
  }
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  const accuracy = Number(location.accuracy);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw validationError('The captured latitude is invalid. Please capture your location again.');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw validationError('The captured longitude is invalid. Please capture your location again.');
  }
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 500) {
    throw validationError('Location accuracy must be within 500 metres. Enable precise location and try again.');
  }
  return { latitude, longitude, accuracy };
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
    || (!lead?.sales_owner_id && String(lead?.assigned_to || '').trim() === actorName(user));
}

async function resolveSalesOwner(data, user, db = pool) {
  if (['salesperson', 'sales_engineer', 'presales'].includes(roleOf(user))) {
    if ((data.sales_owner_id && String(data.sales_owner_id) !== String(user.id))
      || (data.assigned_to && String(data.assigned_to).trim() !== actorName(user))) {
      throw Object.assign(new Error('Only Admin and Sales Head can assign a lead to another salesperson.'), { statusCode: 403 });
    }
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
       AND role IN ('salesperson', 'sales_engineer', 'presales')`,
    [ownerId],
  );
  if (!result.rows[0]) throw validationError('Select an active salesperson, sales engineer, or presales user.');
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

function pincode(value) {
  if (value === undefined || value === null || value === '') return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length !== 6) throw validationError('Billing PIN code must be exactly 6 digits.');
  return digits;
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

function normalizeFollowup(data = {}) {
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
  };
}

async function resolveFollowupAssignee(data = {}, fallback = {}) {
  const requestedId = Number(data.assigned_to_user_id || fallback.id);
  const requestedName = text(data.assigned_to || fallback.name, 'Assigned to', 255);
  const result = Number.isInteger(requestedId) && requestedId > 0
    ? await pool.query(
      `SELECT id, first_name, last_name, role FROM users WHERE id = $1 AND is_active = TRUE`,
      [requestedId],
    )
    : await pool.query(
      `SELECT id, first_name, last_name, role
       FROM users
       WHERE is_active = TRUE
         AND LOWER(TRIM(CONCAT_WS(' ', first_name, last_name))) = LOWER(TRIM($1))
       ORDER BY id ASC
       LIMIT 1`,
      [requestedName],
    );
  const assignee = result.rows[0];
  if (!assignee) throw validationError('Select an active user for this follow-up.');
  return {
    id: assignee.id,
    name: [assignee.first_name, assignee.last_name].filter(Boolean).join(' '),
    role: assignee.role,
  };
}

function canReceiveLeadFollowup(lead, assignee) {
  return ['admin', 'sales_head', 'presales'].includes(roleOf(assignee))
    || String(lead?.sales_owner_id || '') === String(assignee?.id || '')
    || String(lead?.assigned_to || '').trim() === actorName(assignee);
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
    `INSERT INTO lead_activities (lead_id, activity_type, content, actor_user_id, actor_name, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${activityColumns('lead_activities')}`,
    [leadId, type, content, user?.id || null, actorName(user), JSON.stringify(metadata)],
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
          'actor_user_id', a.actor_user_id,
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
    ['project_name', 'project name'],
    ['contact_person_name', 'contact person'],
    ['contact_person_email', 'contact email'],
    ['contact_person_phone', 'contact phone'],
    ['enquiry_date', 'enquiry date'],
    ['enquiry_state', 'enquiry state'],
    ['sales_approval_status', 'approved make'],
    ['priority', 'priority'],
    ['segment', 'segment'],
    ['site_location', 'site location'],
    ['billing_state', 'billing state'],
    ['billing_district', 'billing district'],
    ['billing_city', 'billing city'],
    ['billing_pincode', 'billing PIN code'],
    ['precise_location', 'precise location'],
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
  const salesApprovalStatus = text(leadData.sales_approval_status || 'Vivid Not Approved', 'Approved Make', 30, true);
  if (!SALES_APPROVAL_STATUSES.has(salesApprovalStatus)) throw validationError('Approved Make is invalid.');
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
    text(Array.isArray(leadData.enquiry_product) ? leadData.enquiry_product.join(', ') : leadData.enquiry_product, 'Products', 1000, true),
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
    text(leadData.project_name, 'Project name', 255, true),
    text(leadData.billing_state, 'Billing state', 255),
    text(leadData.billing_district, 'Billing district', 255),
    text(leadData.billing_city, 'Billing city', 255),
    pincode(leadData.billing_pincode),
    text(leadData.precise_location, 'Precise location', 2000),
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
  const where = individual ? `WHERE NULLIF(to_jsonb(l)->>'sales_owner_id', '')::BIGINT = $1 OR (NULLIF(to_jsonb(l)->>'sales_owner_id', '') IS NULL AND l.assigned_to = $2)` : '';
  const result = await pool.query(`
    SELECT ${LEAD_TABLE_COLUMNS},
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', a.id,
          'lead_id', a.lead_id,
          'activity_type', a.activity_type,
          'content', a.content,
          'actor_user_id', a.actor_user_id,
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
  const values = normalizeFollowup(followupData);
  if (values.followupType === 'Meeting' && values.status === 'Completed') {
    throw validationError('Schedule the onsite meeting first, then complete it with a captured location.');
  }
  const assignee = await resolveFollowupAssignee(followupData, {
    id: lead.sales_owner_id || user?.id,
    name: lead.assigned_to || actorName(user),
  });
  if (!canReceiveLeadFollowup(lead, assignee)) {
    throw validationError('Assign the follow-up to the lead owner or a user with team lead access.');
  }
  const result = await pool.query(
    `INSERT INTO lead_followups (
      lead_id,
      followup_type,
      title,
      notes,
      due_at,
      priority,
      status,
      assigned_to_user_id,
      assigned_to,
      completed_at,
      created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $7::varchar = 'Completed' THEN CURRENT_TIMESTAMP ELSE NULL END, $10)
    RETURNING ${followupColumns('lead_followups')}`,
    [lead.id, values.followupType, values.title, values.notes, values.dueAt, values.priority, values.status, assignee.id, assignee.name, actorName(user)],
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

  const values = normalizeFollowup(followupData);
  if (values.followupType === 'Meeting' && values.status === 'Completed' && existing.rows[0].status !== 'Completed') {
    throw validationError('Use the onsite completion action so the meeting location can be captured.');
  }
  const assignee = await resolveFollowupAssignee(followupData, {
    id: existing.rows[0].assigned_to_user_id || lead.sales_owner_id || user?.id,
    name: existing.rows[0].assigned_to || lead.assigned_to || actorName(user),
  });
  if (!canReceiveLeadFollowup(lead, assignee)) {
    throw validationError('Assign the follow-up to the lead owner or a user with team lead access.');
  }
  const result = await pool.query(
    `UPDATE lead_followups
     SET followup_type = $1,
         title = $2,
         notes = $3,
         due_at = $4,
         priority = $5,
         status = $6,
         assigned_to_user_id = $7,
         assigned_to = $8,
         completed_at = CASE
           WHEN $6::varchar = 'Completed' AND completed_at IS NULL THEN CURRENT_TIMESTAMP
           WHEN $6::varchar <> 'Completed' THEN NULL
           ELSE completed_at
         END,
         completion_latitude = CASE WHEN $6::varchar = 'Completed' THEN completion_latitude ELSE NULL END,
         completion_longitude = CASE WHEN $6::varchar = 'Completed' THEN completion_longitude ELSE NULL END,
         completion_accuracy_m = CASE WHEN $6::varchar = 'Completed' THEN completion_accuracy_m ELSE NULL END,
         location_captured_at = CASE WHEN $6::varchar = 'Completed' THEN location_captured_at ELSE NULL END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $9 AND lead_id = $10
     RETURNING ${followupColumns('lead_followups')}`,
    [values.followupType, values.title, values.notes, values.dueAt, values.priority, values.status, assignee.id, assignee.name, followupId, lead.id],
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

async function completeLeadFollowup(leadId, followupId, completionData, user) {
  const lead = await leadForAccess(leadId, user);
  const existing = await pool.query(
    `SELECT ${followupColumns()}
     FROM lead_followups f
     WHERE f.id = $1 AND f.lead_id = $2`,
    [followupId, lead.id],
  );
  const current = existing.rows[0] || null;
  if (!current) return null;
  if (current.status === 'Completed') return current;

  const onsite = current.followup_type === 'Meeting';
  if (onsite && String(current.assigned_to_user_id || '') !== String(user?.id || '')) {
    const error = new Error('Only the assigned sales engineer can complete this onsite meeting.');
    error.statusCode = 403;
    throw error;
  }
  const location = onsite ? normalizeCompletionLocation(completionData?.location) : null;
  const result = await pool.query(
    `UPDATE lead_followups
     SET status = 'Completed',
         completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
         completion_latitude = $3,
         completion_longitude = $4,
         completion_accuracy_m = $5,
         location_captured_at = CASE WHEN $3::numeric IS NOT NULL THEN CURRENT_TIMESTAMP ELSE NULL END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND lead_id = $2
     RETURNING ${followupColumns('lead_followups')}`,
    [followupId, lead.id, location?.latitude ?? null, location?.longitude ?? null, location?.accuracy ?? null],
  );
  const followup = result.rows[0] || null;
  if (!followup) return null;
  await logLeadActivity(lead.id, {
    activity_type: onsite ? 'meeting' : 'system',
    content: `${onsite ? 'Onsite meeting completed with captured location' : 'Follow-up completed'}: ${followup.followup_type} - ${followup.title}`,
    metadata: onsite ? {
      followup_id: followup.id,
      location: {
        latitude: Number(followup.completion_latitude),
        longitude: Number(followup.completion_longitude),
        accuracy_m: Number(followup.completion_accuracy_m),
        captured_at: followup.location_captured_at,
      },
    } : {},
  }, user);
  return followup;
}

async function cancelLeadFollowup(leadId, followupId, user) {
  const lead = await leadForAccess(leadId, user);
  const result = await pool.query(
    `UPDATE lead_followups
     SET status = 'Cancelled',
         completed_at = NULL,
         completion_latitude = NULL,
         completion_longitude = NULL,
         completion_accuracy_m = NULL,
         location_captured_at = NULL,
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
       city,
       state,
       billing_address,
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
    billing_city: leadData.billing_city || customer.city,
    billing_state: leadData.billing_state || customer.state,
    precise_location: leadData.precise_location || customer.billing_address,
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
    const ownedLeadData = leadDataForCustomer({ ...leadData, enquiry_date: leadData.enquiry_date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }), assigned_to: owner.name }, customer);
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
        loss_reason,
        project_name,
        billing_state,
        billing_district,
        billing_city,
        billing_pincode,
        precise_location
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
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

async function updateLead(id, leadData, user, options = {}) {
  const ownTransaction = !options.db;
  const client = options.db || await pool.connect();
  let previous;
  let lead;
  let owner;
  try {
    if (ownTransaction) await client.query('BEGIN');
    const previousResult = await client.query(
      `SELECT ${LEAD_COLUMNS}
       FROM leads
       WHERE id = $1
       FOR UPDATE`,
      [id],
    );
    previous = previousResult.rows[0];
    if (!previous) {
      if (ownTransaction) await client.query('ROLLBACK');
      return null;
    }
    if (!canAccessLead(previous, user)) throw Object.assign(new Error('You can update only leads assigned to you.'), { statusCode: 403 });

    if (['admin', 'sales_head'].includes(roleOf(user))) {
      owner = await resolveSalesOwner({ ...leadData, sales_owner_id: leadData.sales_owner_id || previous.sales_owner_id }, user, client);
    } else {
      if ((leadData.sales_owner_id && String(leadData.sales_owner_id) !== String(previous.sales_owner_id || ''))
        || (leadData.assigned_to !== undefined && String(leadData.assigned_to || '').trim() !== String(previous.assigned_to || '').trim())) {
        throw Object.assign(new Error('Only Admin and Sales Head can change the assigned salesperson.'), { statusCode: 403 });
      }
      owner = { id: previous.sales_owner_id || null, name: previous.assigned_to };
    }
    const customer = await selectedCustomerForLead(client, leadData.customer_id || previous.customer_id);
    const ownedLeadData = options.approvedChangeId
      ? { ...leadData, assigned_to: owner.name }
      : leadDataForCustomer({ ...leadData, assigned_to: owner.name }, customer);
    await ensureLeadSourceAllowed(ownedLeadData.lead_source, previous.lead_source);
    await ensureLossReasonAllowed(ownedLeadData.lead_status, ownedLeadData.loss_reason);
    const values = leadValues(ownedLeadData);
    await ensureLeadStatusAllowed({
      ...previous,
      quotation: values[12] || previous.quotation,
    }, values[14]);
    if (roleOf(user) === 'sales_engineer' && !options.approvedChangeId) {
      const { LEAD_EDIT_FIELDS, submitLeadChange } = require('../services/leadChangeService');
      const normalized = Object.fromEntries(LEAD_EDIT_FIELDS.slice(0, 27).map((field, index) => [field, values[index]]));
      const proposed = { ...normalized, customer_id: customer.id, sales_owner_id: owner.id };
      const request = await submitLeadChange(client, previous, proposed, user, leadData.change_reviewers);
      if (ownTransaction) await client.query('COMMIT');
      return request;
    }
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
         project_name = $25,
         billing_state = $26,
         billing_district = $27,
         billing_city = $28,
         billing_pincode = $29,
         precise_location = $30,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $31
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
           AND status NOT IN ('cancelled', 'discarded', 'dropped')`,
        [owner.id, owner.name, id],
      );
    }
    if (changed(previous, lead, 'project_name')) {
      await client.query(
        `UPDATE estimation_requests
         SET project_name = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE lead_id = $2
           AND status NOT IN ('cancelled', 'discarded', 'dropped')`,
        [lead.project_name, id],
      );
    }
    if (ownTransaction) await client.query('COMMIT');
  } catch (error) {
    if (ownTransaction) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (ownTransaction) client.release();
  }

  // Approved changes and their audit records commit together with both votes.
  const activityDb = options.db || pool;
  for (const content of leadUpdateActivities(previous, lead)) {
    const activity = { activity_type: 'system', content, metadata: options.approvedChangeId ? { request_id: options.approvedChangeId } : {} };
    if (options.db) await insertLeadActivity(lead.id, activity, user, activityDb);
    else await logLeadActivity(lead.id, activity, user, activityDb);
  }

  if ((changed(previous, lead, 'assigned_to') || String(previous.sales_owner_id || '') !== String(owner.id))
    && String(owner.id) !== String(user?.id || '')) {
    await notifyUserId(owner.id, {
      title: 'Lead assigned to you',
      body: `${actorName(user)} assigned ${lead.company_name} to you.`,
      category: 'lead',
      link_type: 'lead',
      link_id: lead.id,
    }, activityDb);
  }

  return options.db ? lead : (await retrieveLead(lead.id)) || lead;
}

async function setLeadWorkflowState(id, data, user) {
  const action = String(data?.action || '').trim().toLowerCase();
  if (!['hold', 'resume', 'drop'].includes(action)) throw validationError('Workflow action must be hold, resume, or drop.');
  const reason = action === 'resume' ? null : text(data?.reason, `${action === 'hold' ? 'Hold' : 'Drop'} reason`, 2000, true);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT * FROM leads WHERE id = $1 FOR UPDATE`, [id]);
    const lead = result.rows[0];
    if (!lead) throw Object.assign(new Error('Lead not found.'), { statusCode: 404 });
    if (!canAccessLead(lead, user)) throw Object.assign(new Error('You can update only leads assigned to you.'), { statusCode: 403 });

    if (action === 'hold') {
      if (lead.lead_status === 'On Hold') throw Object.assign(new Error('This lead is already on hold.'), { statusCode: 409 });
      if (['Dropped', 'Lost'].includes(lead.lead_status)) throw Object.assign(new Error('A dropped or lost lead cannot be put on hold.'), { statusCode: 409 });
      await client.query(
        `UPDATE leads SET status_before_hold = lead_status, lead_status = 'On Hold', hold_reason = $2, held_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id, reason],
      );
      await client.query(
        `UPDATE estimation_requests SET status_before_hold = status, status = 'on_hold', hold_reason = $2, held_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE lead_id = $1 AND status NOT IN ('on_hold', 'dropped', 'discarded', 'cancelled')`,
        [id, reason],
      );
    } else if (action === 'resume') {
      if (lead.lead_status !== 'On Hold') throw Object.assign(new Error('Only a lead on hold can be resumed.'), { statusCode: 409 });
      await client.query(
        `UPDATE leads SET lead_status = COALESCE(NULLIF(status_before_hold, ''), 'New'), status_before_hold = NULL, hold_reason = NULL, held_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id],
      );
      await client.query(
        `UPDATE estimation_requests SET status = COALESCE(NULLIF(status_before_hold, ''), 'submitted'), status_before_hold = NULL, hold_reason = NULL, held_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE lead_id = $1 AND status = 'on_hold'`,
        [id],
      );
    } else {
      if (lead.lead_status === 'Dropped') throw Object.assign(new Error('This lead is already dropped.'), { statusCode: 409 });
      await client.query(
        `UPDATE leads SET lead_status = 'Dropped', drop_reason = $2, dropped_at = CURRENT_TIMESTAMP, status_before_hold = NULL, hold_reason = NULL, held_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id, reason],
      );
      await client.query(
        `UPDATE estimation_requests SET status = 'dropped', drop_reason = $2, dropped_at = CURRENT_TIMESTAMP, status_before_hold = NULL, hold_reason = NULL, held_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE lead_id = $1 AND status NOT IN ('dropped', 'discarded', 'cancelled')`,
        [id, reason],
      );
    }

    const label = action === 'hold' ? `Lead put on hold. Reason: ${reason}`
      : action === 'drop' ? `Lead dropped. Reason: ${reason}` : 'Lead resumed from hold.';
    await insertLeadActivity(id, { activity_type: 'system', content: label, metadata: { event: `lead_${action}`, reason } }, user, client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return retrieveLead(id);
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
    const leadToDelete = await client.query(
      `SELECT
         company_name,
         NULLIF(to_jsonb(leads)->>'project_name', '') AS project_name,
         NULLIF(to_jsonb(leads)->>'enquiry_number', '') AS enquiry_number
       FROM leads
       WHERE id = $1`,
      [id],
    );
    const leadSnapshot = leadToDelete.rows[0] || {};
    await insertLeadActivity(id, {
      activity_type: 'system',
      content: `Lead deleted: ${leadSnapshot.company_name || `Lead #${id}`}`,
      metadata: {
        event: 'lead_deleted',
        company_name: leadSnapshot.company_name || null,
        project_name: leadSnapshot.project_name || null,
        enquiry_number: leadSnapshot.enquiry_number || null,
      },
    }, user, client);
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
  if (roleOf(user) === 'sales_engineer') {
    const { leadSnapshot } = require('../services/leadChangeService');
    return updateLead(id, { ...leadSnapshot(previous), lead_status: 'Proposal Accepted', quotation: quotation && quotation !== 'Sent' ? quotation : sentQuotation.quotation_number }, user);
  }
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
  setLeadWorkflowState,
  deleteLead,
  acceptProposal,
};
