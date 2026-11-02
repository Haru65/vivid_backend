const pool = require('../config/db_connection');
const { createNotification } = require('./notificationService');

function indiaDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).formatToParts(now).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday };
}

function nextMonday(dateValue) {
  const date = new Date(`${dateValue}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 3);
  return date.toISOString().slice(0, 10);
}

async function sendFridayTaskPlanningReminders(db = pool, now = new Date()) {
  const today = indiaDateParts(now);
  if (today.weekday !== 'Friday') return { sent: 0, skipped: true };
  const weekStart = nextMonday(today.date);
  const members = await db.query(`SELECT id, first_name, last_name FROM users WHERE is_active = TRUE AND role IN ('salesperson', 'sales_engineer', 'presales')`);
  let sent = 0;
  for (const member of members.rows) {
    const claimed = await db.query(`INSERT INTO task_planning_reminders (recipient_user_id, week_start) VALUES ($1, $2) ON CONFLICT (recipient_user_id, week_start) DO NOTHING RETURNING id`, [member.id, weekStart]);
    if (!claimed.rows[0]) continue;
    await createNotification({ id: member.id, name: [member.first_name, member.last_name].filter(Boolean).join(' ') }, { title: 'Plan next week’s sales visits', body: `Please add your customer visit tasks for the week starting ${weekStart.split('-').reverse().join('-')}.`, category: 'task_planning', link_type: 'task_planning', metadata: { week_start: weekStart } }, db);
    sent += 1;
  }
  return { sent, skipped: false, weekStart };
}

async function sendMondayTaskReviewReminders(db = pool, now = new Date()) {
  const today = indiaDateParts(now);
  if (today.weekday !== 'Monday') return { sent: 0, skipped: true };
  const weekStart = today.date;
  const [heads, summary] = await Promise.all([
    db.query(`SELECT id, first_name, last_name FROM users WHERE is_active = TRUE AND role = 'sales_head'`),
    db.query(`SELECT COUNT(*)::int AS visits, COUNT(DISTINCT created_by_user_id)::int AS engineers FROM visit_tasks WHERE meeting_at >= $1::date AND meeting_at < $1::date + INTERVAL '7 days' AND status <> 'cancelled'`, [weekStart]),
  ]);
  const visits = Number(summary.rows[0]?.visits || 0);
  const engineers = Number(summary.rows[0]?.engineers || 0);
  let sent = 0;
  for (const head of heads.rows) {
    const claimed = await db.query(`INSERT INTO task_planning_reminders (recipient_user_id, week_start) VALUES ($1, $2) ON CONFLICT (recipient_user_id, week_start) DO NOTHING RETURNING id`, [head.id, weekStart]);
    if (!claimed.rows[0]) continue;
    await createNotification({ id: head.id, name: [head.first_name, head.last_name].filter(Boolean).join(' ') }, {
      title: 'Review this week’s sales visit plan',
      body: `${visits} visit${visits === 1 ? '' : 's'} planned by ${engineers} sales engineer${engineers === 1 ? '' : 's'}. Open Tasks to review the plan; this notification is marked as read when opened.`,
      category: 'task_planning_review',
      link_type: 'task_planning',
      metadata: { week_start: weekStart, visits, engineers },
    }, db);
    sent += 1;
  }
  return { sent, skipped: false, weekStart, visits, engineers };
}

module.exports = { sendFridayTaskPlanningReminders, sendMondayTaskReviewReminders, indiaDateParts, nextMonday };
