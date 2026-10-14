const pool = require('../config/db_connection');
const { logLeadActivity } = require('./leads');

const MEETING_COLUMNS = `
  m.id,
  m.title,
  m.description,
  m.meeting_type,
  m.start_at,
  m.end_at,
  m.all_day,
  m.status,
  m.owner_name,
  m.owner_user_id,
  m.location,
  m.lead_id,
  m.created_at,
  m.updated_at,
  l.company_name AS lead_company_name,
  l.contact_person_name AS lead_contact_name,
  l.assigned_to AS lead_owner
  ,l.sales_owner_id AS lead_owner_user_id
`;

const STATUSES = new Set(['Scheduled', 'Completed', 'Cancelled']);
const MEETING_TYPES = new Set(['Meeting', 'Call', 'Demo', 'Site Visit', 'Follow-up']);

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
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
  if (typeof value !== 'string' || !value.trim()) {
    throw validationError(`${field} is required.`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw validationError(`${field} must be a valid date and time.`);
  return date.toISOString();
}

function optionalLeadId(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw validationError('Lead must be a valid lead ID.');
  return id;
}

function optionalUserId(value, field = 'Owner') {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw validationError(`${field} must be a valid user.`);
  return id;
}

function meetingValues(data, fallbackOwner) {
  const startAt = timestamp(data.start_at, 'Start time');
  const endAt = timestamp(data.end_at, 'End time');
  if (new Date(endAt) <= new Date(startAt)) throw validationError('End time must be after start time.');

  const meetingType = data.meeting_type || 'Meeting';
  if (!MEETING_TYPES.has(meetingType)) throw validationError('Meeting type is invalid.');
  const status = data.status || 'Scheduled';
  if (!STATUSES.has(status)) throw validationError('Meeting status is invalid.');

  return {
    title: text(data.title, 'Title', 255, true),
    description: text(data.description, 'Description', 5000),
    meetingType,
    startAt,
    endAt,
    allDay: Boolean(data.all_day),
    status,
    ownerName: text(data.owner_name || fallbackOwner, 'Owner', 255, true),
    ownerUserId: optionalUserId(data.owner_user_id),
    location: text(data.location, 'Location', 255),
    leadId: optionalLeadId(data.lead_id),
  };
}

async function leadForMeeting(leadId) {
  if (!leadId) return null;
  const result = await pool.query(
    'SELECT id, company_name, assigned_to, sales_owner_id FROM leads WHERE id = $1',
    [leadId],
  );
  if (!result.rows[0]) {
    const error = new Error('Lead not found.');
    error.statusCode = 404;
    throw error;
  }
  return result.rows[0];
}

function isAdmin(user) {
  return ['admin', 'sales_head'].includes(user?.role);
}

function userCanAccessLead(lead, user) {
  return isAdmin(user)
    || !lead
    || String(lead.sales_owner_id || '') === String(user?.id || '')
    || (!lead.sales_owner_id && lead.assigned_to === user.name);
}

function userOwnsMeeting(meeting, user) {
  return String(meeting?.owner_user_id || '') === String(user?.id || '')
    || (!meeting?.owner_user_id && meeting?.owner_name === user?.name);
}

async function resolveMeetingOwner(values, user) {
  if (!isAdmin(user)) {
    return { id: user.id, name: user.name };
  }
  const ownerUserId = values.ownerUserId || (values.ownerName === user.name ? user.id : null);
  if (!ownerUserId) throw validationError('Choose an active meeting owner.');
  const result = await pool.query(
    `SELECT id, first_name, last_name
     FROM users
     WHERE id = $1
       AND is_active = TRUE
       AND role IN ('admin', 'sales_head', 'sales_engineer', 'salesperson')`,
    [ownerUserId],
  );
  const owner = result.rows[0];
  if (!owner) throw validationError('Meeting owner must be an active sales workspace user.');
  return { id: owner.id, name: [owner.first_name, owner.last_name].filter(Boolean).join(' ') };
}

async function assertCanManageLead(leadId, user) {
  const lead = await leadForMeeting(leadId);
  if (!userCanAccessLead(lead, user)) {
    const error = new Error('Salespersons can only manage meetings for their assigned leads.');
    error.statusCode = 403;
    throw error;
  }
  return lead;
}

async function retrieveMeetings(range, user) {
  const start = range.start ? timestamp(range.start, 'Calendar range start') : null;
  const end = range.end ? timestamp(range.end, 'Calendar range end') : null;
  const admin = isAdmin(user);
  const result = await pool.query(
    `SELECT ${MEETING_COLUMNS}
     FROM meetings m
     LEFT JOIN leads l ON l.id = m.lead_id
     WHERE ($1::timestamptz IS NULL OR m.end_at >= $1::timestamptz)
       AND ($2::timestamptz IS NULL OR m.start_at <= $2::timestamptz)
       AND ($3::boolean = TRUE
         OR m.owner_user_id = $4
         OR (m.owner_user_id IS NULL AND m.owner_name = $5)
         OR l.sales_owner_id = $4
         OR (l.sales_owner_id IS NULL AND l.assigned_to = $5))
     ORDER BY m.start_at ASC, m.id ASC`,
    [start, end, admin, user.id, user.name],
  );
  return result.rows;
}

async function createMeeting(data, user) {
  const values = meetingValues(data, user.name);
  await assertCanManageLead(values.leadId, user);
  const owner = await resolveMeetingOwner(values, user);

  const result = await pool.query(
    `INSERT INTO meetings (
      title, description, meeting_type, start_at, end_at, all_day,
      status, owner_name, owner_user_id, location, lead_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id`,
    [values.title, values.description, values.meetingType, values.startAt, values.endAt,
      values.allDay, values.status, owner.name, owner.id, values.location, values.leadId],
  );

  const meeting = await retrieveMeeting(result.rows[0].id, user);
  if (meeting?.lead_id) {
    await logLeadActivity(meeting.lead_id, {
      activity_type: 'meeting',
      content: `${meeting.meeting_type} scheduled: ${meeting.title}`,
    }, user);
  }
  return meeting;
}

async function retrieveMeeting(id, user) {
  const result = await pool.query(
    `SELECT ${MEETING_COLUMNS}
     FROM meetings m
     LEFT JOIN leads l ON l.id = m.lead_id
     WHERE m.id = $1
       AND ($2::boolean = TRUE
         OR m.owner_user_id = $3
         OR (m.owner_user_id IS NULL AND m.owner_name = $4)
         OR l.sales_owner_id = $3
         OR (l.sales_owner_id IS NULL AND l.assigned_to = $4))`,
    [id, isAdmin(user), user.id, user.name],
  );
  return result.rows[0] || null;
}

async function updateMeeting(id, data, user) {
  const existing = await retrieveMeeting(id, user);
  if (!existing) return null;
  const values = meetingValues(data, existing.owner_name);
  await assertCanManageLead(values.leadId, user);
  if (!isAdmin(user) && !userOwnsMeeting(existing, user)) {
    const error = new Error('Salespersons can only update their own meetings.');
    error.statusCode = 403;
    throw error;
  }
  const owner = await resolveMeetingOwner(values, user);

  const result = await pool.query(
    `UPDATE meetings
     SET title = $1,
         description = $2,
         meeting_type = $3,
         start_at = $4,
         end_at = $5,
         all_day = $6,
         status = $7,
         owner_name = $8,
         owner_user_id = $9,
         location = $10,
         lead_id = $11,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $12
     RETURNING id`,
    [values.title, values.description, values.meetingType, values.startAt, values.endAt,
      values.allDay, values.status, owner.name, owner.id, values.location, values.leadId, id],
  );
  const meeting = await retrieveMeeting(result.rows[0].id, user);
  if (meeting?.lead_id) {
    const statusChanged = existing.status !== meeting.status;
    const timeChanged = String(existing.start_at) !== String(meeting.start_at)
      || String(existing.end_at) !== String(meeting.end_at);
    await logLeadActivity(meeting.lead_id, {
      activity_type: 'meeting',
      content: statusChanged
        ? `${meeting.meeting_type} ${meeting.status.toLowerCase()}: ${meeting.title}`
        : timeChanged
          ? `${meeting.meeting_type} rescheduled: ${meeting.title}`
          : `${meeting.meeting_type} updated: ${meeting.title}`,
    }, user);
  }
  if (existing.lead_id && String(existing.lead_id) !== String(meeting?.lead_id || '')) {
    await logLeadActivity(existing.lead_id, {
      activity_type: 'meeting',
      content: `${existing.meeting_type} moved away from this lead: ${existing.title}`,
    }, user);
  }
  return meeting;
}

async function deleteMeeting(id, user) {
  const existing = await retrieveMeeting(id, user);
  if (!existing) return null;
  if (!isAdmin(user) && !userOwnsMeeting(existing, user)) {
    const error = new Error('Salespersons can only delete their own meetings.');
    error.statusCode = 403;
    throw error;
  }
  const result = await pool.query('DELETE FROM meetings WHERE id = $1 RETURNING id', [id]);
  if (result.rows[0] && existing.lead_id) {
    await logLeadActivity(existing.lead_id, {
      activity_type: 'meeting',
      content: `${existing.meeting_type} deleted: ${existing.title}`,
    }, user);
  }
  return result.rows[0] || null;
}

module.exports = { retrieveMeetings, createMeeting, updateMeeting, deleteMeeting };
