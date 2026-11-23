const pool = require('../config/db_connection');

const ALLOWED_ACTIVITY_TYPES = new Set([
  'note',
  'call',
  'whatsapp',
  'system',
  'email',
  'meeting',
  'negotiation',
  'approval_requested',
  'approval',
]);

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function validDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function activityError(message, statusCode = 403) {
  return Object.assign(new Error(message), { statusCode });
}

const SALES_TEAM_ROLES = ['salesperson', 'sales_engineer', 'presales'];
const DASHBOARD_MEMBER_ROLES = {
  admin: [...SALES_TEAM_ROLES, 'sales_head', 'estimation_head', 'estimation_manager', 'estimation_engineer'],
  sales_head: SALES_TEAM_ROLES,
  estimation_head: [...SALES_TEAM_ROLES, 'estimation_manager', 'estimation_engineer'],
  estimation_manager: [...SALES_TEAM_ROLES, 'estimation_engineer'],
};

async function authorizeTeamTrail(query, user, actorId, leadId, db) {
  if (!actorId) throw activityError('Select an engineer to view activity.', 400);
  const result = await db.query(
    `SELECT id, role, TRIM(CONCAT_WS(' ', first_name, last_name)) AS name FROM users WHERE id = $1`,
    [actorId],
  );
  const member = result.rows[0];
  if (!member || !DASHBOARD_MEMBER_ROLES[user.role]?.includes(member.role)
    || (user.role === 'estimation_manager' && String(user.id) === String(member.id))) {
    throw activityError('You cannot view this team member’s activity.');
  }
  const team = query.team || (SALES_TEAM_ROLES.includes(member.role) || member.role === 'sales_head' ? 'sales' : 'estimation');
  const teamRoles = team === 'sales' ? [...SALES_TEAM_ROLES, 'sales_head']
    : team === 'estimation' ? ['estimation_head', 'estimation_manager', 'estimation_engineer', 'presales'] : [];
  if (!teamRoles.includes(member.role)) throw activityError('This member does not belong to the selected team.');
  if (!leadId) return;

  const requests = await db.query('SELECT * FROM estimation_requests WHERE lead_id = $1', [leadId]);
  const sameId = (value) => value != null && String(value) === String(member.id);
  const sameName = (value) => Boolean(member.name?.trim())
    && String(value || '').trim().toLowerCase() === member.name.trim().toLowerCase();
  const belongsToMember = requests.rows.some((request) => {
    if (team === 'estimation') {
      const head = member.role === 'estimation_head';
      const id = head ? request.estimation_head_id : request.assigned_engineer_id;
      return id ? sameId(id) : sameName(head ? request.estimation_head_name : request.assigned_engineer_name);
    }
    return [request.sales_owner_id, request.requested_by_user_id, request.sales_head_id].some(sameId)
      || [request.sales_owner_name, request.requested_by_name].some(sameName);
  });
  if (!belongsToMember) throw activityError('This project is not assigned to the selected team member.');
}

async function listActivityLogs(query = {}, user = {}, db = pool) {
  const page = positiveInteger(query.page, 1, 1000000);
  const limit = positiveInteger(query.limit, 50, 100);
  const offset = (page - 1) * limit;
  const conditions = [];
  const values = [];
  const addValue = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  const actorIdText = String(query.actor_id || '').trim();
  const actorId = /^\d+$/.test(actorIdText) && Number.isSafeInteger(Number(actorIdText)) ? Number(actorIdText) : 0;
  const leadIdText = String(query.lead_id || '').trim();
  const leadId = /^\d+$/.test(leadIdText) && Number.isSafeInteger(Number(leadIdText)) ? Number(leadIdText) : 0;
  const teamDashboard = query.scope === 'team_dashboard';
  if (!DASHBOARD_MEMBER_ROLES[user.role]) throw activityError('You cannot view activity logs.');
  if (user.role === 'estimation_manager' && !teamDashboard) {
    throw activityError('Estimation Managers can view activity through the team dashboard only.');
  }
  if (teamDashboard) {
    if (leadIdText && !leadId) throw activityError('Select a valid project.', 400);
    await authorizeTeamTrail(query, user, actorId, leadId, db);
  }

  // The general Estimation Head log remains approval-only. The dashboard may
  // request the selected engineer's activity, but only for supported team roles.
  const approvalOnly = user.role === 'estimation_head' && !teamDashboard;
  if (approvalOnly) conditions.push(`a.activity_type IN ('approval_requested', 'approval')`);
  if (teamDashboard && !leadId) {
    conditions.push(`a.actor_user_id = ${addValue(actorId)}`);
  }

  if (leadId) conditions.push(`a.lead_id = ${addValue(leadId)}`);

  const search = String(query.q || '').trim().slice(0, 200);
  if (search) {
    const placeholder = addValue(`%${search}%`);
    conditions.push(`(
      a.content ILIKE ${placeholder}
      OR a.actor_name ILIKE ${placeholder}
      OR COALESCE(l.company_name, a.metadata->>'company_name', '') ILIKE ${placeholder}
      OR COALESCE(NULLIF(to_jsonb(l)->>'project_name', ''), a.metadata->>'project_name', '') ILIKE ${placeholder}
      OR COALESCE(NULLIF(to_jsonb(l)->>'enquiry_number', ''), a.metadata->>'enquiry_number', '') ILIKE ${placeholder}
      OR CAST(a.lead_id AS TEXT) ILIKE ${placeholder}
    )`);
  }

  const type = String(query.type || '').trim();
  if (type && ALLOWED_ACTIVITY_TYPES.has(type)) conditions.push(`a.activity_type = ${addValue(type)}`);

  const actor = String(query.actor || '').trim().slice(0, 255);
  if (actor) conditions.push(`LOWER(a.actor_name) = LOWER(${addValue(actor)})`);

  const from = validDate(query.from);
  if (from) conditions.push(`a.created_at >= ${addValue(from)}::date`);

  const to = validDate(query.to);
  if (to) conditions.push(`a.created_at < (${addValue(to)}::date + INTERVAL '1 day')`);

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const baseFrom = `
    FROM lead_activities a
    LEFT JOIN leads l ON l.id = a.lead_id
    LEFT JOIN users u ON u.id = a.actor_user_id
    ${where}
  `;

  const countResult = await db.query(`SELECT COUNT(*)::INTEGER AS total ${baseFrom}`, values);
  const pageValues = [...values, limit, offset];
  const rowsResult = await db.query(
    `SELECT
       a.id,
       a.lead_id,
       a.activity_type,
       a.content,
       a.actor_user_id,
       a.actor_name,
       a.metadata,
       a.created_at,
       COALESCE(NULLIF(to_jsonb(l)->>'enquiry_number', ''), a.metadata->>'enquiry_number') AS enquiry_number,
       COALESCE(l.company_name, a.metadata->>'company_name') AS company_name,
       COALESCE(NULLIF(to_jsonb(l)->>'project_name', ''), a.metadata->>'project_name') AS project_name,
       l.lead_status,
       u.role AS actor_role
     ${baseFrom}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $${values.length + 1}
     OFFSET $${values.length + 2}`,
    pageValues,
  );

  const metadataWhere = approvalOnly
    ? " WHERE activity_type IN ('approval_requested', 'approval')"
    : '';
  const metadataValues = teamDashboard ? values : [];
  const [typesResult, actorsResult] = await Promise.all([
    db.query(teamDashboard
      ? `SELECT DISTINCT a.activity_type ${baseFrom} ORDER BY a.activity_type ASC`
      : `SELECT DISTINCT activity_type FROM lead_activities${metadataWhere} ORDER BY activity_type ASC`, metadataValues),
    db.query(teamDashboard ? `
      SELECT a.actor_name, MIN(a.actor_user_id) AS actor_user_id
      ${baseFrom} AND NULLIF(TRIM(a.actor_name), '') IS NOT NULL
      GROUP BY a.actor_name ORDER BY a.actor_name ASC
    ` : `
      SELECT actor_name, MIN(actor_user_id) AS actor_user_id
      FROM lead_activities
      WHERE NULLIF(TRIM(actor_name), '') IS NOT NULL
        ${approvalOnly ? "AND activity_type IN ('approval_requested', 'approval')" : ''}
      GROUP BY actor_name
      ORDER BY actor_name ASC
    `, metadataValues),
  ]);

  const total = countResult.rows[0]?.total || 0;
  return {
    items: rowsResult.rows,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    activity_types: typesResult.rows.map((row) => row.activity_type),
    actors: actorsResult.rows,
  };
}

module.exports = { listActivityLogs };
