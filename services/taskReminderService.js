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

module.exports = { sendFridayTaskPlanningReminders, indiaDateParts, nextMonday };
