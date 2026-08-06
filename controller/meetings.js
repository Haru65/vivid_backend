const pool = require('../config/db_connection');

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
  m.location,
  m.lead_id,
  m.created_at,
  m.updated_at,
  l.company_name AS lead_company_name,
  l.contact_person_name AS lead_contact_name,
  l.assigned_to AS lead_owner
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
    location: text(data.location, 'Location', 255),
    leadId: optionalLeadId(data.lead_id),
  };
}

async function leadForMeeting(leadId) {
  if (!leadId) return null;
  const result = await pool.query(
    'SELECT id, company_name, assigned_to FROM leads WHERE id = $1',
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
  return user?.role === 'admin';
}

function userCanAccessLead(lead, user) {
  return isAdmin(user) || !lead || lead.assigned_to === user.name;
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
       AND ($3::boolean = TRUE OR m.owner_name = $4 OR l.assigned_to = $4)
     ORDER BY m.start_at ASC, m.id ASC`,
    [start, end, admin, user.name],
  );
  return result.rows;
}

async function createMeeting(data, user) {
  const values = meetingValues(data, user.name);
  await assertCanManageLead(values.leadId, user);
  if (!isAdmin(user) && values.ownerName !== user.name) {
    const error = new Error('Salespersons can only create meetings for themselves.');
    error.statusCode = 403;
    throw error;
  }

  const result = await pool.query(
    `INSERT INTO meetings (
      title, description, meeting_type, start_at, end_at, all_day,
      status, owner_name, location, lead_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id`,
    [values.title, values.description, values.meetingType, values.startAt, values.endAt,
      values.allDay, values.status, values.ownerName, values.location, values.leadId],
  );

  return retrieveMeeting(result.rows[0].id, user);
}

async function retrieveMeeting(id, user) {
  const result = await pool.query(
    `SELECT ${MEETING_COLUMNS}
     FROM meetings m
     LEFT JOIN leads l ON l.id = m.lead_id
     WHERE m.id = $1
       AND ($2::boolean = TRUE OR m.owner_name = $3 OR l.assigned_to = $3)`,
    [id, isAdmin(user), user.name],
  );
  return result.rows[0] || null;
}

async function updateMeeting(id, data, user) {
  const existing = await retrieveMeeting(id, user);
  if (!existing) return null;
  const values = meetingValues(data, existing.owner_name);
  await assertCanManageLead(values.leadId, user);
  if (!isAdmin(user) && (existing.owner_name !== user.name || values.ownerName !== user.name)) {
    const error = new Error('Salespersons can only update their own meetings.');
    error.statusCode = 403;
    throw error;
  }

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
         location = $9,
         lead_id = $10,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $11
     RETURNING id`,
    [values.title, values.description, values.meetingType, values.startAt, values.endAt,
      values.allDay, values.status, values.ownerName, values.location, values.leadId, id],
  );
  return retrieveMeeting(result.rows[0].id, user);
}

async function deleteMeeting(id, user) {
  const existing = await retrieveMeeting(id, user);
  if (!existing) return null;
  if (!isAdmin(user) && existing.owner_name !== user.name) {
    const error = new Error('Salespersons can only delete their own meetings.');
    error.statusCode = 403;
    throw error;
  }
  const result = await pool.query('DELETE FROM meetings WHERE id = $1 RETURNING id', [id]);
  return result.rows[0] || null;
}

module.exports = { retrieveMeetings, createMeeting, updateMeeting, deleteMeeting };
