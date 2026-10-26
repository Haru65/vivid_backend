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

async function listActivityLogs(query = {}) {
  const page = positiveInteger(query.page, 1, 1000000);
  const limit = positiveInteger(query.limit, 50, 100);
  const offset = (page - 1) * limit;
  const conditions = [];
  const values = [];
  const addValue = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

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

  const countResult = await pool.query(`SELECT COUNT(*)::INTEGER AS total ${baseFrom}`, values);
  const pageValues = [...values, limit, offset];
  const rowsResult = await pool.query(
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

  const [typesResult, actorsResult] = await Promise.all([
    pool.query('SELECT DISTINCT activity_type FROM lead_activities ORDER BY activity_type ASC'),
    pool.query(`
      SELECT actor_name, MIN(actor_user_id) AS actor_user_id
      FROM lead_activities
      WHERE NULLIF(TRIM(actor_name), '') IS NOT NULL
      GROUP BY actor_name
      ORDER BY actor_name ASC
    `),
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
